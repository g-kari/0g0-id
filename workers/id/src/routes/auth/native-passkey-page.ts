/** No CDN, cross-origin WebAuthn, account lookup, or automatic credential prompt. */
export function nativePasskeyPage(csrf: string, nonce: string, afterSignup = false): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(csrf) || !/^[A-Za-z0-9_-]{22}$/.test(nonce))
    throw new Error("Invalid page context");
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>0g0 ID · パスキーでログイン</title>
<style nonce="${nonce}">
body{margin:0;background:#f5f7fa;color:#172333;font:1rem/1.7 system-ui,sans-serif;display:grid;min-height:100svh;place-items:center}
main{box-sizing:border-box;width:min(100% - 2rem,28rem);padding:2rem;background:#fff;border:1px solid #dce3eb;border-radius:1rem}
h1{font-size:1.5rem}button{font:inherit;cursor:pointer;border:0;border-radius:.5rem;background:#174a7e;color:#fff;padding:.8rem 1rem;width:100%}
button:disabled{cursor:wait;opacity:.6}button:focus-visible,a:focus-visible{outline:3px solid #d77c14;outline-offset:4px}
p{margin:1rem 0}#status{min-height:3.4rem}small{color:#4b5d70}a{color:#174a7e}
</style></head><body><main><small>0g0 ID</small><h1>パスキーでログイン</h1>
<p>${afterSignup ? "今作成したパスキーを選び、もう一度本人確認してください。登録だけではログインは完了していません。" : "このサイトに登録したパスキーを選び、端末の画面で本人確認してください。"}</p>
<form method="post" action="/auth/passkey/verify" id="login-form">
<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="credential" id="credential">
<button type="button" id="login">パスキーを選んでログイン</button></form>
<p id="status" role="status" aria-live="polite"></p>
<small>メールの確認やアカウント登録は、この操作では行いません。</small>
<noscript><p>パスキーの利用には JavaScript が必要です。</p></noscript>
<script nonce="${nonce}">
const button=document.getElementById('login');
const status=document.getElementById('status');
const form=document.getElementById('login-form');
let active=null;
const decode=(s)=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),x=>x.charCodeAt(0));
const encode=(buffer)=>btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=/g,'');
button.addEventListener('click',async()=>{
  if(active)return;
  const controller=new AbortController(); active=controller; button.disabled=true;
  status.textContent='端末の確認画面を開いています。';
  try{
    if(!window.PublicKeyCredential||!navigator.credentials)throw new Error('unsupported');
    const result=await fetch('/auth/passkey/options',{method:'POST',credentials:'same-origin',cache:'no-store',
      signal:controller.signal,headers:{'Content-Type':'application/json'},
      body:JSON.stringify({csrf:form.elements.csrf.value,confirm:true})});
    if(!result.ok)throw new Error('unavailable');
    const data=await result.json();
    const key=await navigator.credentials.get({signal:controller.signal,publicKey:{
      challenge:decode(data.options.challenge),rpId:data.options.rpId,userVerification:'required',timeout:60000}});
    if(controller.signal.aborted)return;
    if(!key)throw new Error('unavailable');
    const proof={id:key.id,rawId:encode(key.rawId),type:key.type,clientExtensionResults:key.getClientExtensionResults(),response:{
      authenticatorData:encode(key.response.authenticatorData),clientDataJSON:encode(key.response.clientDataJSON),
      signature:encode(key.response.signature),userHandle:key.response.userHandle?encode(key.response.userHandle):null}};
    document.getElementById('credential').value=JSON.stringify(proof);
    status.textContent='ログインを確認しています。';
    // A normal top-level POST receives the existing authorization-code redirect.
    // fetch must not follow that redirect to a different BFF/client origin.
    form.submit();
  }catch(error){
    status.textContent=error.name==='NotAllowedError'||error.name==='AbortError'
      ?'操作をキャンセルしました。もう一度選べます。'
      :'ログインできませんでした。時間をおいて、元のサービスからやり直してください。';
    if(!controller.signal.aborted){active=null;button.disabled=false;}
  }
});
window.addEventListener('pagehide',()=>{if(active)active.abort();});
window.addEventListener('pageshow',(event)=>{if(event.persisted)location.reload();});
</script></main></body></html>`;
}
