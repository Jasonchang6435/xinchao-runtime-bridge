"""Isolated real-heart/bridge checks: no egress, host ports or production data."""
import json, os, subprocess, time, uuid

suffix = uuid.uuid4().hex[:10]
heart = 'xinchao-bridge-lab-heart-' + suffix
bridge = 'xinchao-bridge-lab-worker-' + suffix
receiver = 'xinchao-bridge-lab-receiver-' + suffix
volume = 'xinchao-bridge-lab-state-' + suffix
heart_image = os.environ.get('XINCHAO_TEST_HEART_IMAGE', 'xinchao-zeabur-heart:20261009')
bridge_image = os.environ.get('XINCHAO_TEST_BRIDGE_IMAGE', 'xinchao-bridge:runtime-20261012')
service_token = 'synthetic-service-' + '1' * 64
machine_token = 'synthetic-machine-' + '2' * 64
dashboard_token = 'synthetic-dashboard-' + '3' * 64
webhook_token = 'synthetic-webhook-' + '4' * 64
checks = []

def docker(*args, allow_fail=False):
    p = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=40)
    if p.returncode and not allow_fail:
        raise RuntimeError('Docker lab operation failed: ' + args[0] + '; synthetic output suppressed')
    return p

def node(container, code):
    return json.loads(docker('exec', container, 'node', '-e', code).stdout)

def check(name, valid):
    if not valid: raise AssertionError(name)
    checks.append(name)

def wait(check_fn):
    for _ in range(60):
        try:
            value = check_fn()
            if value: return value
        except (RuntimeError, ValueError): pass
        time.sleep(0.2)
    raise RuntimeError('Docker lab readiness timeout')

def api(path, payload=None, token=service_token):
    code = "(async()=>{const r=await fetch('http://127.0.0.1:18110'+" + json.dumps(path) + ",{method:" + json.dumps('POST' if payload is not None else 'GET') + ",headers:{Authorization:'Bearer '+" + json.dumps(token) + ",'Content-Type':'application/json'}," + ("body:JSON.stringify(" + json.dumps(payload) + ")," if payload is not None else '') + "signal:AbortSignal.timeout(3000)});console.log(JSON.stringify({status:r.status,data:await r.json()}))})()"
    return node(heart, code)

def status():
    return node(bridge, "(async()=>{const r=await fetch('http://127.0.0.1:8080/readyz');console.log(JSON.stringify({status:r.status,data:await r.json()}))})()")

def queue():
    return node(heart, "const fs=require('node:fs');console.log(fs.readFileSync('/app/state/bridge-queue.json','utf8'))")['deliveries']

def start_bridge(live=False):
    # Emulate Zeabur's root override, even though the image declares USER node.
    args = ['run', '-d', '--name', bridge, '--user', '0:0', '--network', 'container:' + heart,
            '-e', 'DRY_RUN=' + ('false' if live else 'true'),
            '-e', 'XINCHAO_BRIDGE_BASE_URL=http://127.0.0.1:18110',
            '-e', 'XINCHAO_BRIDGE_MACHINE_TOKEN=' + machine_token,
            '-e', 'XINCHAO_BRIDGE_ACCEPT_SELF_SIGNALS=true',
            '-e', 'XINCHAO_BRIDGE_INJECTOR_MODE=webhook',
            '-e', 'XINCHAO_BRIDGE_RETRY_MIN_MS=100', '-e', 'XINCHAO_BRIDGE_RETRY_MAX_MS=500']
    if live:
        args += ['-e', 'XINCHAO_BRIDGE_WEBHOOK_URL=http://127.0.0.1:8791/wake',
                 '-e', 'XINCHAO_BRIDGE_WEBHOOK_TOKEN=' + webhook_token]
    docker(*args, bridge_image)
    wait(lambda: status()['status'] == 200)

def enqueue(event_id):
    session = api('/dashboard/session', {'accessToken': dashboard_token, 'mode': 'header'})
    check('dashboard session authenticated ' + event_id, session['status'] == 200)
    token = session['data'].get('token') or session['data'].get('sessionToken')
    if not token: raise RuntimeError('No synthetic dashboard session token')
    result = api('/dashboard/api/bridge/deliveries', {'event_id': event_id, 'message': 'synthetic lab note'}, token)
    check('synthetic queue enqueue ' + event_id, result['status'] == 201)
    return result['data']['deliveryId']

try:
    docker('volume', 'create', volume)
    docker('run', '-d', '--name', heart, '--network', 'none', '-v', volume + ':/app/state',
           '-e', 'SERVICE_TOKEN=' + service_token, '-e', 'PORT=18110', '-e', 'SHADOW_MODE=true',
           '-e', 'MODEL_ENABLED=false', '-e', 'DREAM_ENABLED=false', '-e', 'BRIDGE_ENABLED=true',
           '-e', 'BRIDGE_MACHINE_TOKEN=' + machine_token, '-e', 'BRIDGE_SELF_SIGNALS=false',
           '-e', 'DASHBOARD_ENABLED=true', '-e', 'DASHBOARD_ACCESS_TOKEN=' + dashboard_token,
           '-e', 'DASHBOARD_PUBLIC_BASE_URL=http://localhost:18110', heart_image)
    wait(lambda: api('/health')['status'] == 200)
    check('heart has no network egress', json.loads(docker('inspect', heart).stdout)[0]['HostConfig']['NetworkMode'] == 'none')
    delivery = enqueue('synthetic-bridge-lab-001')
    start_bridge()
    wait(lambda: status()['data']['noticesObserved'] >= 1)
    check('dry-run is explicit and has no receiver', status()['data']['deliveryEnabled'] is False and status()['data']['receiverConfigured'] is False)
    check('dry-run leaves actual heart delivery pending', next(d for d in queue() if d['id'] == delivery)['status'] == 'pending')
    check('bridge main process drops root even when platform overrides Docker USER', node(bridge, "const fs=require('node:fs');console.log(JSON.stringify(Number(fs.readFileSync('/proc/1/status','utf8').match(/^Uid:\\s+(\\d+)/m)[1])))") == 1000)
    later_delivery = enqueue('synthetic-bridge-lab-002')
    wait(lambda: status()['data']['noticesObserved'] >= 2)
    check('new delivery arrives on the existing live SSE connection', next(d for d in queue() if d['id'] == later_delivery)['status'] == 'pending')
    for round_num in range(2):
        docker('rm', '-f', bridge)
        start_bridge()
        wait(lambda: status()['data']['noticesObserved'] >= 1)
        check('recreation preserves pending delivery round ' + str(round_num + 1), next(d for d in queue() if d['id'] == delivery)['status'] == 'pending')
    docker('rm', '-f', bridge)
    docker('restart', heart)
    wait(lambda: api('/health')['status'] == 200)
    check('heart restart preserves queue on its own volume', next(d for d in queue() if d['id'] == delivery)['status'] == 'pending')
    receiver_code = r"""
const http=require('node:http');let accepted=0;
http.createServer(async(req,res)=>{
 if(req.url==='/count'){res.end(JSON.stringify({accepted}));return;}
 if(req.headers.authorization!=='Bearer '+process.env.SYNTHETIC_WEBHOOK_TOKEN){res.writeHead(401).end();return;}
 let raw='';for await(const c of req)raw+=c;const v=JSON.parse(raw);accepted++;
 res.end(JSON.stringify({accepted:true,deliveryId:v.deliveryId}));
}).listen(8791,'127.0.0.1');
"""
    docker('run', '-d', '--name', receiver, '--network', 'container:' + heart,
           '-e', 'SYNTHETIC_WEBHOOK_TOKEN=' + webhook_token, bridge_image, 'node', '-e', receiver_code)
    wait(lambda: node(heart, "(async()=>{const r=await fetch('http://127.0.0.1:8791/count');console.log(await r.text())})()")['accepted'] == 0)
    start_bridge(live=True)
    wait(lambda: next(d for d in queue() if d['id'] == delivery)['status'] == 'delivered')
    wait(lambda: next(d for d in queue() if d['id'] == later_delivery)['status'] == 'delivered')
    check('live strict ACK marks real heart queue delivered', next(d for d in queue() if d['id'] == delivery)['attempts'] == 0)
    check('synthetic receiver accepted both deliveries once', node(heart, "(async()=>{const r=await fetch('http://127.0.0.1:8791/count');console.log(await r.text())})()")['accepted'] == 2)
    check('default image dry-run env', 'DRY_RUN=true' in json.loads(docker('image', 'inspect', bridge_image).stdout)[0]['Config']['Env'])
    check('no host ports published', not json.loads(docker('inspect', bridge).stdout)[0]['HostConfig']['PortBindings'])
    print(json.dumps({'passed':len(checks),'checks':checks,'productionRequests':0,'hostPorts':0,'syntheticOnly':True}, ensure_ascii=False))
finally:
    for name in [bridge, receiver, heart]: docker('rm', '-f', name, allow_fail=True)
    docker('volume', 'rm', volume, allow_fail=True)
