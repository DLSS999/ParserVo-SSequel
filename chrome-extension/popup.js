const ids=["apiBaseUrl","shop","token","plnRate","eurRate","autoQueue"];
const $=(id)=>document.getElementById(id);
const call=(action,extra={})=>chrome.runtime.sendMessage({action,...extra});
async function refresh(){const r=await call("state");if(!r?.ok)return;$("version").textContent=`v${r.version}`;for(const id of ids){if(id==="autoQueue")$(id).checked=r.settings[id]!==false;else $(id).value=r.settings[id]??"";}$("status").textContent=`${r.running?"RUNNING":"IDLE"}: ${r.current}`;$("stats").textContent=`Processed ${r.stats.processed}/${r.stats.total} · Imported ${r.stats.captured} · Failed ${r.stats.failed}`;$("log").textContent=(r.logs||[]).join("\n");}
$("save").onclick=async()=>{const settings={};for(const id of ids)settings[id]=id==="autoQueue"?$(id).checked:$(id).value;const r=await call("save",{settings});alert(r.ok?"Saved":r.error);refresh();};
$("test").onclick=async()=>{const r=await call("test");alert(r.ok?"API connection successful":r.error);refresh();};
$("start").onclick=async()=>{await call("start");refresh();};
$("stop").onclick=async()=>{await call("stop");refresh();};
$("capture").onclick=async()=>{const r=await call("capture-current");alert(r.ok?"Product imported":r.error);refresh();};
$("clear").onclick=async()=>{await call("clear-log");refresh();};
refresh();setInterval(refresh,1500);
