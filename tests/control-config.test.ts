import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONTROL_CONFIG_FILES, mutationMatches, resolveConfigMutations } from "../src/config-mutations.js";
import { createClawAegisRuntime } from "../src/handlers.js";
import type { OpenClawPluginApi } from "../runtime-api.js";

const dirs: string[]=[];
afterEach(async()=>{
  // Audit writes are deliberately asynchronous in the production hook.
  await new Promise(resolve=>setTimeout(resolve,10));
  await Promise.all(dirs.splice(0).map(dir=>fs.promises.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:10})));
});
function fixture(settings:Record<string,unknown>={},host:"openclaw"|"hermes"="openclaw") {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"aegis-control-"));dirs.push(dir);
  const work=path.join(dir,"workspace"),state=path.join(dir,"profile");
  fs.mkdirSync(work);fs.mkdirSync(state);
  for(const file of CONTROL_CONFIG_FILES) fs.writeFileSync(path.join(state,file),"ORIGINAL");
  const api={rootDir:path.join(dir,"plugin"),config:{},pluginConfig:{skillScanEnabled:false,...settings},
    logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn()},runtime:{state:{resolveStateDir:()=>state}},
    on:vi.fn(),getPluginConfig:()=>undefined,resolvePath:(p:string)=>path.resolve(p)} as OpenClawPluginApi;
  const runtime=createClawAegisRuntime(api,{stateDir:path.join(dir,"data"),host});
  const call=async(toolName:string,params:Record<string,unknown>,ctx:Record<string,unknown>={})=>
    runtime.hooks.before_tool_call({toolName,params},{workspaceDir:work,...ctx});
  return {dir,work,state,runtime,call,api};
}

describe("Gateway management semantics and modes",()=>{
  it.each(["restart","config.apply","config.patch","update.run"])("blocks %s before execution",async action=>{
    const f=fixture();expect((await f.call("gateway",{action:" "+action+" ",note:"配置了cati-proxy SSE MCP服务器连接用户本机CATI，重启加载MCP客户端"}))?.block).toBe(true);
  });
  it.each(["config.get","config.schema.lookup","status","RESTART",undefined])("preserves action %s",async action=>{
    const f=fixture();expect(await f.call("gateway",{action,note:"restart; cat > ~/.openclaw/mcp-servers.json5"})).toBeUndefined();
  });
  it("binds host identity to the adapter, not caller input",async()=>{
    const f=fixture();expect((await f.call("gateway",{action:"restart",host:"hermes"},{host:"hermes"}))?.block).toBe(true);
    expect(await f.call("other_gateway",{action:"restart"})).toBeUndefined();
    expect(await fixture({},"hermes").call("gateway",{action:"restart"},{host:"openclaw"})).toBeUndefined();
  });
  it("uses trusted lifecycle workspace when native tool hooks omit it",async()=>{
    const f=fixture(),p=path.join(f.state,CONTROL_CONFIG_FILES[0]);
    const ctx={agentId:"alpha",sessionKey:"a",runId:"r",workspaceDir:f.work};
    await f.runtime.hooks.before_prompt_build({},ctx);
    const event={toolName:"write",params:{path:path.relative(f.work,p),content:"{}",workdir:"/tmp/fake"}};
    expect((await f.runtime.hooks.before_tool_call(event,{...ctx,workspaceDir:undefined}))?.block).toBe(true);
    expect(await f.runtime.hooks.before_tool_call(event,{sessionKey:"other",agentId:"beta"})).toBeUndefined();
    f.runtime.hooks.session_end({},{sessionKey:"a"});
    expect(await f.runtime.hooks.before_tool_call(event,{...ctx,workspaceDir:undefined})).toBeUndefined();
  });
  it.each(["observe","off"])("honors %s",async mode=>{
    const f=fixture({defaultBlockingMode:mode});
    for(const action of ["restart","config.apply","config.patch","update.run"]) expect(await f.call("gateway",{action})).toBeUndefined();
  });
  it("honors global off and independent mode sources",async()=>{
    expect(await fixture({allDefensesEnabled:false}).call("gateway",{action:"restart"})).toBeUndefined();
    const a=fixture({commandBlockMode:"off",selfProtectionMode:"enforce"});
    expect(await a.call("gateway",{action:"restart"})).toBeUndefined();
    expect((await a.call("gateway",{action:"config.patch"}))?.block).toBe(true);
    const b=fixture({commandBlockMode:"enforce",selfProtectionMode:"off"});
    expect((await b.call("gateway",{action:"config.apply"}))?.block).toBe(true);
    expect(await b.call("write",{path:path.join(b.state,CONTROL_CONFIG_FILES[0]),content:"{}"})).toBeUndefined();
  });
});

describe.each(CONTROL_CONFIG_FILES)("%s mutation-only protection",file=>{
  const target=path.join(os.homedir(),".openclaw",file),base="/tmp/aegis-config-work";
  const matches=(command:string)=>resolveConfigMutations("exec",{command},base).some(m=>mutationMatches(m,[target]));
  it.each([
    `cat > ${target} <<'EOF'\n{}\nEOF`, `cat>${target} <<'EOF'\n{}\nEOF`,
    `cat ./fragment >> '${target}'`, `printf '{}' | tee '${target}'`, `tee -a '${target}' < ./fragment`,
    `printf '{}' >| '${target}'`, `echo hi 2>'${target}'`, `: > '${target}'`,
    `(cat > '${target}')`, `cat <(printf changed > '${target}')`, `(printf changed) > '${target}'`,
    `cat > ~/.openclaw/${file} <<'EOF'\n{}\nEOF`, `cat > "$HOME/.openclaw/${file}"`,
    `cat > "\${HOME}/.openclaw/${file}"`, `TARGET='${target}'; cat > "$TARGET"`,
    `export TARGET='${target}'; printf '{}' > "$TARGET"`,
    `TARGET=~/.openclaw/${file}; cat > "$TARGET"`,
    `TARGET='${target}'; echo "$(printf x > \"$TARGET\")"`,
    `cd '${path.dirname(target)}' && cat > ${file}`, `cd /tmp; cat > '${target}'`,
    `cp ./new '${target}'`, `mv ./new '${target}'`, `mv '${target}' ./backup`,
    `cp -t '${path.dirname(target)}' './${file}'`,
    `sed -i 's/a/b/' '${target}'`, `rm -f '${target}'`, `rm -rf '${path.dirname(target)}'`,
    `sed -i -e 's/a/b/' '${target}'`, `sed -i '' -e 's/a/b/' '${target}'`,
    `sed -i.bak -es/a/b/ '${target}'`,
    `cat <<EOF\n$(printf changed > '${target}')\nEOF`,
    `cat <<EOF\n'$(printf changed > '${target}')'\nEOF`,
    "cat <<EOF\n`printf changed > '"+target+"'`\nEOF",
    `sh -c 'cat > "${target}"'`, `bash -lc 'printf x >> "${target}"'`,
    `node -e 'require("fs").writeFileSync("${target}","{}")'`,
    `node -e 'const fs=require("node:fs"); const dest="${target}"; fs.appendFileSync(dest,"{}")'`,
    `node -e 'require("fs").writeFileSync(process.env.HOME+"/.openclaw/${file}","{}")'`,
    `node -e 'const fs=require("fs/promises"); fs.writeFile("${target}","{}")'`,
    `python3 -c 'open("${target}","w").write("{}")'`,
    `python3 -c 'open(mode="w",file="${target}").write("{}")'`,
    `python3 -c 'from pathlib import Path; Path("${target}").write_text("{}")'`,
    `python3 -c 'from pathlib import Path; p=Path.home()/".openclaw"/"${file}"; p.write_bytes(b"{}")'`,
    `python3 -c 'import os; p=os.path.join(os.path.expanduser("~"),".openclaw","${file}"); open(p,"a")'`,
    `python3 <<'PY'\nfrom pathlib import Path\nPath("${target}").write_text("{}")\nPY`,
    `node <<'JS'\nrequire("fs").writeFileSync("${target}","{}")\nJS`,
  ])("detects actual modifications: %s",command=>expect(matches(command)).toBe(true));

  it.each([
    `cat '${target}'`, `head '${target}'`, `cp '${target}' ./backup`, `cat '${target}' > ./backup`,
    `printf '%s' '${target}'`, `echo 'cat > ${target}'`, `printf 'cat > ${target}' > ./notes`,
    `cat <<'EOF' > ./notes\ncat > ${target}\nEOF`,
    `cat <<'EOF'\n$(printf changed > '${target}')\nEOF`,
    `cat <<EOF\n\\$(printf changed > '${target}')\nEOF`,
    `touch -r '${target}' ./ordinary`, `touch --reference='${target}' ./ordinary`,
    `truncate -r '${target}' ./ordinary`, `truncate --reference='${target}' ./ordinary`,
    `sed -i -f '${target}' ./ordinary`,
    `cat <<'EOF'\nnode -e 'require("fs").writeFileSync("${target}","{}")'\nEOF`,
    `node -e 'console.log("${target}")'`, `node -e 'console.log("require(\\"fs\\").writeFileSync(\\"${target}\\",\\"{}\\")")'`,
    `node -e 'require("fs").readFileSync("${target}")'`,
    `python3 -c 'open("${target}","r").read()'`,
    `python3 -c 'print("${target}")'`,
    `python3 -c '# open("${target}","w")\nprint(1)'`,
    `node -e 'custom.writeFileSync("${target}","{}")'`,
    `TARGET='${target}'; TARGET=./report; cat > "$TARGET"`,
    `TARGET='${target}'; unset TARGET; cat > "$TARGET"`,
    `false && TARGET='${target}'; cat > "$TARGET"`,
    `TARGET='${target}'; if true; then TARGET=./ordinary; fi; cat > "$TARGET"`,
    `HOME=/tmp/other; cat > "$HOME/.openclaw/${file}"`,
    `cat > '~/.openclaw/${file}'`, `cat > '$HOME/.openclaw/${file}'`,
    `TARGET="~/.openclaw/${file}"; cat > "$TARGET"`,
    `(cd /tmp/ordinary && cat > ${file})`,
    `cat > ./report.json`, `cat > ./${file}`, `cat > ${target}.example`,
    `command -v tee '${target}'`, `cp --help '${target}'`,
    `python3 -c 'import os; os.chdir("/tmp/ordinary"); open("${file}","w")'`,
    `python3 -c 'def example():\n  open("${target}","w")'`,
  ])("retains normal behavior: %s",command=>expect(matches(command)).toBe(false));

  it("guards direct tools, profile paths and patch moves, preserving reads",async()=>{
    const f=fixture(),p=path.join(f.state,file);
    for(const [tool,params] of [
      ["write",{path:p,content:"{}"}],["edit",{file_path:p,old_string:"x",new_string:"y"}],
      ["write",{path:path.relative(f.work,p),content:"{}",workdir:"/tmp/ordinary"}],
      ["edit",{file_path:path.relative(f.work,p),old_string:"x",new_string:"y",workdir:"/tmp/ordinary"}],
      ["apply_patch",{input:`*** Begin Patch\n  *** Add File: ${p}\n+changed\n*** End Patch`}],
      ["apply_patch",{input:`*** Begin Patch\n*** Update File: ./ordinary\n*** Move to: ${p}\n@@\n-a\n+b\n*** End Patch`}],
      ["exec",{command:`cat > ${file}`,workdir:f.state}],
    ] as const) expect((await f.call(tool,params))?.block).toBe(true);
    for(const [tool,params] of [
      ["read",{path:p}],["exec",{command:`cat '${p}'`}],["write",{path:path.join(f.work,file),content:"{}"}],
      ["write",{path:path.join(f.work,"notes.md"),content:`cat > ${p}`}],
      ["apply_patch",{input:`*** Begin Patch\n*** Update File: ./notes.md\n@@\n *** Add File: ${p}\n-old\n+new\n*** End Patch`}],
    ] as const) expect(await f.call(tool,params)).toBeUndefined();
    const hermes=fixture({},"hermes");
    expect(await hermes.call("write",{path:path.join(hermes.state,file),content:"{}"})).toBeUndefined();
  });
  it("resolves symlinks according to the operation, including missing children",()=>{
    const f=fixture(),p=path.join(f.state,file),alias=path.join(f.work,"alias");fs.symlinkSync(p,alias);
    const match=(command:string)=>resolveConfigMutations("exec",{command},f.work).some(m=>mutationMatches(m,[p]));
    expect(match(`echo x > '${alias}'`)).toBe(true);
    expect(match(`rm -f '${alias}'`)).toBe(false);
    expect(match(`mv ./ordinary '${alias}'`)).toBe(false);
    fs.symlinkSync(f.state,path.join(f.work,"profile-link"));fs.unlinkSync(p);
    expect(match(`cat > ./profile-link/${file}`)).toBe(true);
    fs.symlinkSync(path.join(f.work,"referent"),p);
    expect(match(`rm -f '${p}'`)).toBe(true);
  });
  it.each(["observe","off"])("honors mutation mode %s",async mode=>{
    const f=fixture({selfProtectionMode:mode});
    expect(await f.call("write",{path:path.join(f.state,file),content:"{}"})).toBeUndefined();
  });
});
