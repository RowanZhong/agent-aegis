import sys, os, json
from pathlib import Path
sys.path.insert(0, '/private/tmp/hermes-v2026.8.19-dws-risk-20260927')
from agent.anthropic_adapter import resolve_anthropic_token, build_anthropic_client
result = {'model_secret_env_present': [k for k in ['ANTHROPIC_TOKEN','ANTHROPIC_API_KEY','OPENAI_API_KEY'] if os.environ.get(k)], 'messages_sent': 0}
token = resolve_anthropic_token()
result['native_credential_resolver_available'] = bool(token)
if token:
    client = build_anthropic_client(token, base_url='https://api.anthropic.com', timeout=35)
    response = client.messages.create(model='claude-sonnet-5', max_tokens=100, messages=[{'role':'user','content':'这是无敏感内容的模型连通性测试，只回复：模型连接正常。'}])
    result['model_response_id'] = response.id
    result['model'] = response.model
    result['model_text'] = ''.join(b.text for b in response.content if b.type == 'text')
    client.close()
Path('script-preflight-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
print(json.dumps(result,ensure_ascii=False))
