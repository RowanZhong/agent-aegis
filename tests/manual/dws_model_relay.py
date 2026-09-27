"""Test-only loopback relay backed by real Codex inference; never shipped."""
import json
from pathlib import Path
import subprocess
import shutil
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def start_relay(root, test_model, port=0):
    calls=[]
    backend=root/"inference-backend.py"
    shutil.copyfile(Path(__file__).with_name("codex_model_backend.py"),backend)
    class Relay(BaseHTTPRequestHandler):
        def log_message(self,*_):pass
        def do_POST(self):
            try:
                request=json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                # Real native inference, with no toolsets in the model backend.
                # The actual host receives and enforces every proposed call.
                with (root/"backend.log").open("a") as log:
                    completed=subprocess.run([sys.executable,str(backend),test_model],
                        input=json.dumps(request,ensure_ascii=False),text=True,stdout=subprocess.PIPE,stderr=log,timeout=85,check=True)
                proposed=json.loads(completed.stdout)
                text=proposed["content"]
                tc=[{"id":"call_"+uuid.uuid4().hex,"type":"function","function":{"name":t["name"],"arguments":json.dumps(t["arguments"],ensure_ascii=False)}} for t in proposed["tool_calls"]]
                response_id="native_"+uuid.uuid4().hex
                calls.append({"path":self.path,"response_id":response_id,"model":test_model,
                    "tool_result_ids":[m.get("tool_call_id") for m in request.get("messages",[]) if m.get("role")=="tool"],
                    "tool_calls":tc,"text":text,"stream":bool(request.get("stream"))})
                (root/"model-events.json").write_text(json.dumps(calls,ensure_ascii=False,indent=2))
                finish="tool_calls" if tc else "stop"
                base={"id":response_id,"object":"chat.completion","created":int(time.time()),"model":request.get("model","test")}
                if request.get("stream"):
                    self.send_response(200);self.send_header("Content-Type","text/event-stream");self.end_headers()
                    delta={"role":"assistant","content":text}
                    if tc:delta["tool_calls"]=[{"index":i,**t} for i,t in enumerate(tc)]
                    for d,reason in [(delta,None),({},finish)]:
                        payload={**base,"object":"chat.completion.chunk","choices":[{"index":0,"delta":d,"finish_reason":reason}]}
                        self.wfile.write(("data: "+json.dumps(payload)+"\n\n").encode())
                    self.wfile.write(b"data: [DONE]\n\n")
                else:
                    body={**base,"choices":[{"index":0,"message":{"role":"assistant","content":text,**({"tool_calls":tc} if tc else {})},"finish_reason":finish}]}
                    encoded=json.dumps(body).encode();self.send_response(200);self.send_header("Content-Type","application/json");self.send_header("Content-Length",str(len(encoded)));self.end_headers();self.wfile.write(encoded)
            except Exception as e:
                (root/"relay-error.txt").write_text(type(e).__name__+": "+str(e))
                status=getattr(e,"status_code",502)
                body=json.dumps({"error":{"message":type(e).__name__,"type":"provider_error"}}).encode()
                self.send_response(status);self.send_header("Content-Type","application/json")
                if status==429:self.send_header("Retry-After",getattr(e,"response",None).headers.get("retry-after","60"))
                self.end_headers();self.wfile.write(body)
    relay=ThreadingHTTPServer(("127.0.0.1",port),Relay)
    thread=threading.Thread(target=relay.serve_forever,daemon=True);thread.start()
    return relay, calls
