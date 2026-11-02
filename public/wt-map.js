/* The Great Eight: World Tour map (world -> Europe -> country -> Rome level select).
   Ported from campaign-design/worldtour-map/template.html (the approved prototype) into the real app. A full-screen layer,
   #wtmap, drawn over the Campaign choice screen; everything it needs from the page (story player, portraits, seen-cue
   set) is a global of public/index.html, used at call time only. Loaded as its own script so it is network-first in the
   service worker like sfx.js. The CSS below is generated from the prototype's (every id gets a wm- prefix) and the
   markup is built by open().

   How it works, from the script's own rules:
   - a country's OPENING story plays before its first table is clickable (Rome: when you step into the city);
   - clicking a table starts the game; after a clear the progress updates first, then that table's story plays
     (`<CC>.<n>`), and only after it ends does the next table open;
   - table 9 crowns the champion, table 10 is the Keeper's Table, then the World Championship invitation, the
     country's FOCUS HANDOFF scene (if it has one) and the route moves to the next country;
   - after Paris the world map opens; an unplayed continent plays its preview conversation, then Begin / Not yet;
     once begun it is locked in until its 100 tables are done.
   Progress: a table is cleared when the server's result for it (campaignData.wtResults, tables 401-500, the same
   campaign_level_results the Hundred Tables use) says so; stories seen are `wt_<block>` story-cue ids, a continent begun is
   `wtx_cont_<K>`. Play calls wtStartTable (index.html) which closes this layer and starts the real game; coming back,
   index.html calls WTMAP.afterTable. With ?wtdev=1 a DEV button fakes the clears locally so the flow can be walked through. */
(function(){
'use strict';
const CSS=`#wtmap{
  --bg:#020605;--felt1:#071A15;--felt2:#0D2E25;--land:#123428;--land2:#0b211a;
  --brass:#C49E58;--brass-hi:#EED08E;--brass-lo:#806436;--brass-rgb:196,158,88;
  --cream:#EDE4D2;--muted:#B0CABE;--faint:rgba(176,202,190,.68);--line:rgba(196,158,88,.28);
  --pos:#7FE0B4;
  --serif:'Playfair Display',Georgia,serif;--sans:'DM Sans',system-ui,sans-serif;--num:'IBM Plex Mono',ui-monospace,monospace;
}
#wtmap *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
#wtmap #wm-svg{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none}
#wtmap .grat{fill:none;stroke:rgba(var(--brass-rgb),.035);stroke-width:1;vector-effect:non-scaling-stroke}
#wtmap .land{fill:rgba(2,6,5,0);stroke:rgba(var(--brass-rgb),.16);stroke-width:.6;vector-effect:non-scaling-stroke;stroke-linejoin:round;transition:fill .5s,stroke .5s}
#wtmap .land.w-x{fill:rgba(2,6,5,.14);stroke:rgba(var(--brass-rgb),.05)}
#wtmap .land.far{fill:rgba(2,6,5,.38);stroke:rgba(var(--brass-rgb),.06)}
#wtmap .land.w-locked{fill:rgba(2,6,5,.38);stroke:rgba(var(--brass-rgb),.2)}
#wtmap .land.w-avail{fill:rgba(var(--brass-rgb),.10);stroke:rgba(var(--brass-rgb),.75);cursor:pointer}
#wtmap .land.w-active{fill:rgba(var(--brass-rgb),.16);stroke:var(--brass-hi)}
#wtmap .land.w-done{fill:rgba(var(--brass-rgb),.26);stroke:var(--brass-hi)}
#wtmap .land.nbr{fill:rgba(2,6,5,.22);stroke:rgba(var(--brass-rgb),.16)}
#wtmap .land.k-locked{fill:rgba(2,6,5,.10);stroke:rgba(var(--brass-rgb),.55)}
#wtmap .land.k-active{fill:rgba(var(--brass-rgb),.16);stroke:var(--brass-hi);stroke-width:1.5;cursor:pointer}
#wtmap .land.k-done{fill:rgba(var(--brass-rgb),.28);stroke:var(--brass-hi);stroke-width:1.2;cursor:pointer}
#wtmap .land.k-sel{stroke-width:2.2}
#wtmap .land.k-pending{fill:rgba(2,6,5,.05);stroke:rgba(var(--brass-rgb),.4)}
#wtmap #wm-imgW,#wtmap #wm-imgE{image-rendering:auto;filter:brightness(1.32) contrast(1.06) saturate(1.1)}
#wtmap .route path{fill:none;vector-effect:non-scaling-stroke;stroke-linecap:round}
#wtmap .route .todo{stroke:rgba(var(--brass-rgb),.45);stroke-width:1.6;stroke-dasharray:2 7}
#wtmap .route .done{stroke:var(--brass-hi);stroke-width:2.4;filter:drop-shadow(0 0 3px rgba(var(--brass-rgb),.8))}
#wtmap .mk{cursor:pointer}
#wtmap .mk text{font-family:var(--sans);text-anchor:middle;pointer-events:none}
#wtmap .mk .num{font-family:var(--num);font-weight:600;font-size:12px;dominant-baseline:central}
#wtmap .mk .lbl{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;fill:var(--cream);paint-order:stroke;stroke:rgba(2,6,5,.9);stroke-width:3px;stroke-linejoin:round}
#wtmap .mk .sub{font-size:9px;font-weight:500;letter-spacing:.1em;text-transform:uppercase;fill:var(--muted);paint-order:stroke;stroke:rgba(2,6,5,.9);stroke-width:3px}
#wtmap .mk.locked .lbl{fill:var(--faint)}
#wtmap .pulse{transform-box:fill-box;transform-origin:center;animation:wmpulse 2.2s ease-out infinite}
@keyframes wmpulse{0%{transform:scale(.85);opacity:.8}100%{transform:scale(1.7);opacity:0}}
#wtmap .trav{pointer-events:none}
#wtmap .hud{position:absolute;z-index:10;pointer-events:none}
#wtmap .hud>*{pointer-events:auto}
#wtmap #wm-top{left:max(14px,env(safe-area-inset-left));right:max(14px,env(safe-area-inset-right));top:max(12px,env(safe-area-inset-top));display:flex;align-items:center;gap:10px;height:40px}
#wtmap .hbtn{width:40px;height:40px;border-radius:50%;border:1px solid var(--line);background:rgba(2,6,5,.72);color:var(--brass-hi);font-size:22px;line-height:1;display:grid;place-items:center;cursor:pointer;flex:0 0 auto;font-family:var(--sans);padding:0}
#wtmap .hbtn:active{transform:scale(.94)}
#wtmap #wm-crumb{flex:1;min-width:0;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 6px #000}
#wtmap #wm-crumb b{color:var(--brass-hi);font-weight:700}
#wtmap #wm-seat{flex:0 0 auto;text-align:right;background:rgba(2,6,5,.72);border:1px solid var(--line);border-radius:12px;padding:5px 10px 6px;min-width:128px}
#wtmap #wm-att{flex:0 0 auto;display:flex;align-items:center;gap:6px;background:rgba(2,6,5,.72);border:1px solid var(--line);border-radius:999px;padding:4px 11px 4px 8px;white-space:nowrap}
#wtmap #wm-att .n{font-family:var(--num);font-variant-numeric:tabular-nums;font-size:13px;font-weight:600;color:var(--cream)}
#wtmap #wm-att .r{font-size:9px;letter-spacing:.04em;color:var(--muted)}
#wtmap #wm-att .r:empty{display:none}
#wtmap #wm-seat small{display:block;font-size:8.5px;letter-spacing:.18em;color:var(--muted);text-transform:uppercase}
#wtmap #wm-seat strong{font-family:var(--num);font-size:17px;color:var(--brass-hi);font-weight:600}
#wtmap #wm-seat strong span{font-size:11px;color:var(--muted);font-weight:500}
#wtmap #wm-segs{display:flex;gap:3px;margin-top:3px}
#wtmap #wm-segs i{flex:1;height:4px;border-radius:2px;background:rgba(var(--brass-rgb),.16);overflow:hidden;position:relative}
#wtmap #wm-segs i b{position:absolute;inset:0 auto 0 0;background:linear-gradient(90deg,var(--brass-lo),var(--brass-hi))}
#wtmap #wm-prog{left:max(18px,env(safe-area-inset-left));bottom:max(14px,env(safe-area-inset-bottom));background:rgba(2,6,5,.72);border:1px solid var(--line);border-radius:12px;padding:7px 12px}
#wtmap #wm-prog small{display:block;font-size:8.5px;letter-spacing:.18em;color:var(--muted);text-transform:uppercase}
#wtmap #wm-prog strong{font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--cream)}
#wtmap #wm-prog strong b{color:var(--brass-hi);font-family:var(--num)}
#wtmap #wm-pips{display:flex;gap:4px;margin-top:5px}
#wtmap #wm-pips i{width:14px;height:5px;border-radius:2px;background:rgba(var(--brass-rgb),.18)}
#wtmap #wm-pips i.on{background:var(--brass-hi);box-shadow:0 0 6px rgba(var(--brass-rgb),.8)}
#wtmap #wm-panel{position:absolute;z-index:11;top:max(58px,calc(env(safe-area-inset-top) + 56px));right:max(14px,env(safe-area-inset-right));bottom:max(14px,env(safe-area-inset-bottom));width:min(300px,42vw);overflow:auto;background:radial-gradient(130% 55% at 50% 0%,color-mix(in srgb,var(--ct,#C49E58) 34%,transparent),transparent 72%),url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 90' preserveAspectRatio='none'%3E%3Cpath fill='%23ffffff' fill-opacity='.055' d='M0 90V62h14V48h10V62h8V40l8-12 8 12v22h12V52h14V30h10v22h10V58h16V44h12l6-14 6 14h10v20h14V50h12V36h10v14h10V60h16V46h14V62h12V54h14v36z'/%3E%3C/svg%3E") bottom/100% 90px no-repeat,linear-gradient(180deg,rgba(13,46,37,.94),rgba(7,26,21,.96));border:1px solid var(--line);border-radius:16px;padding:12px 14px;box-shadow:0 10px 40px rgba(0,0,0,.55);transform:translateX(calc(100% + 30px));opacity:0;transition:transform .55s cubic-bezier(.2,.8,.2,1),opacity .4s}
#wtmap #wm-panel.show{transform:none;opacity:1}
#wtmap .ph{display:flex;align-items:center;gap:10px}
#wtmap .ph .t{flex:1;min-width:0}
#wtmap .ph small{display:block;font-size:9px;letter-spacing:.2em;color:var(--muted);text-transform:uppercase}
#wtmap .ph h2{margin:0;font-family:var(--serif);font-size:1.45rem;line-height:1.05;color:var(--brass-hi)}
#wtmap .lead{display:flex;flex-direction:column;align-items:center;gap:2px;font-size:8px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);text-align:center}
#wtmap .mono{width:30px;height:30px;border-radius:50%;border:1.5px solid var(--brass);background:var(--felt1);display:grid;place-items:center;font-family:var(--num);font-size:10px;font-weight:600;color:var(--brass-hi)}
#wtmap .games{margin:6px 0 9px;font-size:10.5px;color:var(--faint);letter-spacing:.04em}
#wtmap .grid{display:grid;grid-template-columns:repeat(5,1fr);gap:6px 4px}
#wtmap .nd{background:none;border:0;padding:0;cursor:pointer;aspect-ratio:1;position:relative}
#wtmap .nd svg{width:100%;height:100%;display:block;overflow:visible}
#wtmap .nd.sel svg{filter:drop-shadow(0 0 5px rgba(var(--brass-rgb),.9))}
#wtmap .cap{margin-top:9px;padding:8px 10px;border:1px solid var(--line);border-radius:10px;background:rgba(2,6,5,.35);min-height:62px}
#wtmap .cap b{display:block;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--brass-hi)}
#wtmap .cap p{margin:3px 0 0;font-size:11px;line-height:1.35;color:var(--cream)}
#wtmap .seats{display:flex;gap:5px;margin-top:6px;flex-wrap:wrap}
#wtmap .seats span{font-size:8.5px;letter-spacing:.1em;text-transform:uppercase;border:1px solid var(--line);border-radius:999px;padding:2px 7px;color:var(--muted)}
#wtmap .seats span.you{color:var(--brass-hi);border-color:var(--brass)}
#wtmap .cta{margin-top:10px;width:100%;min-height:42px;border-radius:12px;border:1px solid var(--brass-hi);background:linear-gradient(180deg,var(--brass-hi),var(--brass));color:#1c1405;font-weight:700;letter-spacing:.12em;text-transform:uppercase;font-size:12px;cursor:pointer;font-family:var(--sans)}
#wtmap .cta:active{transform:scale(.98)}
#wtmap .cta.ghost{background:transparent;color:var(--brass-hi)}
#wtmap #wm-sheet{position:absolute;z-index:14;left:50%;bottom:max(16px,env(safe-area-inset-bottom));width:min(440px,calc(100% - 40px));transform:translate(-50%,calc(100% + 60px));transition:transform .5s cubic-bezier(.2,.8,.2,1);background:linear-gradient(180deg,rgba(13,46,37,.97),rgba(7,26,21,.98));border:1px solid var(--brass);border-radius:16px;padding:12px 16px;box-shadow:0 14px 50px rgba(0,0,0,.7);text-align:center}
#wtmap #wm-sheet.show{transform:translate(-50%,0)}
#wtmap #wm-sheet h3{margin:0;font-family:var(--serif);font-size:1.25rem;color:var(--brass-hi)}
#wtmap #wm-sheet p{margin:5px 0 9px;font-size:11.5px;line-height:1.4;color:var(--cream)}
#wtmap #wm-sheet .row{display:flex;gap:8px}
#wtmap #wm-sheet .row .cta{margin:0}
#wtmap #wm-scrim{position:absolute;inset:0;z-index:20;background:rgba(2,6,5,.78);display:none;place-items:center;padding:14px}
#wtmap #wm-scrim.show{display:grid}
#wtmap #wm-modal{width:min(520px,100%);max-height:100%;overflow:auto;text-align:center;background:linear-gradient(180deg,#0d2e25,#071A15);border:1px solid var(--brass);border-radius:18px;padding:14px 18px;box-shadow:0 20px 70px #000;animation:wmpop .5s cubic-bezier(.2,.9,.3,1.2)}
@keyframes wmpop{from{transform:scale(.88);opacity:0}to{transform:none;opacity:1}}
#wtmap #wm-modal small{display:block;font-size:9px;letter-spacing:.24em;color:var(--muted);text-transform:uppercase}
#wtmap #wm-modal h2{margin:2px 0 4px;font-family:var(--serif);font-size:1.5rem;color:var(--brass-hi);letter-spacing:.02em}
#wtmap #wm-modal p{margin:4px 0;font-size:12px;color:var(--cream)}
#wtmap #wm-modal .seal{width:92px;height:92px;margin:4px auto}
#wtmap .meds{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin:10px 0}
#wtmap .med{display:flex;flex-direction:column;align-items:center;gap:3px;font-size:8.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
#wtmap .med .mono{width:38px;height:38px;font-size:12px;position:relative}
#wtmap #wm-toast{position:absolute;z-index:30;left:50%;top:max(62px,calc(env(safe-area-inset-top) + 58px));transform:translate(-50%,-20px);opacity:0;pointer-events:none;background:rgba(2,6,5,.92);border:1px solid var(--brass);border-radius:999px;padding:7px 16px;font-size:11.5px;color:var(--cream);transition:all .35s;max-width:calc(100% - 40px);text-align:center}
#wtmap #wm-toast.show{opacity:1;transform:translate(-50%,0)}
#wtmap #wm-note{position:absolute;z-index:12;left:50%;top:50%;transform:translate(-50%,-50%);width:min(340px,70%);text-align:center;background:rgba(2,6,5,.82);border:1px solid var(--line);border-radius:14px;padding:12px 16px;font-size:12px;line-height:1.45;display:none}
#wtmap #wm-note b{display:block;font-family:var(--serif);font-size:1.1rem;color:var(--brass-hi);margin-bottom:3px}
@keyframes wmpring{0%{transform:scale(.3);opacity:.95}100%{transform:scale(3.2);opacity:0}}
#wtmap .lead-img{width:46px;height:46px;display:block;margin:0 auto 1px}
#wtmap .land.w-avail-lit{fill:rgba(var(--brass-rgb),.16);stroke:rgba(var(--brass-rgb),.75)}
#wtmap #wm-lvl{position:absolute;inset:0;z-index:6;opacity:0;pointer-events:none;overflow:hidden;overflow:clip;background:#050403;transition:opacity 1s ease}
#wtmap #wm-lvl.on{opacity:1;pointer-events:auto}
#wtmap #wm-lvlBg{position:absolute;inset:0;background:radial-gradient(90% 80% at 50% 40%,#3a2c1d,#120d08 75%);transform:scale(1.08);transition:transform 1.6s cubic-bezier(.2,.75,.2,1)}
#wtmap #wm-lvl.on #wm-lvlBg{transform:none}
#wtmap #wm-lvlBg img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;user-select:none;-webkit-user-drag:none}
#wtmap #wm-lvlShade{position:absolute;inset:0;pointer-events:none;background:linear-gradient(180deg,rgba(2,6,5,.55) 0,transparent 22%,transparent 58%,rgba(2,6,5,.72) 100%),radial-gradient(120% 100% at 50% 50%,transparent 60%,rgba(2,6,5,.5) 100%)}
#wtmap #wm-lvlHead{position:absolute;left:50%;transform:translateX(-50%);top:max(10px,env(safe-area-inset-top));z-index:3;text-align:center;min-width:200px;text-shadow:0 2px 10px #000}
#wtmap #wm-lvlHead small{display:block;font-size:9px;letter-spacing:.2em;text-transform:uppercase;color:var(--brass-hi)}
#wtmap #wm-lvlHead h2{margin:1px 0 4px;font-family:var(--serif);font-weight:700;font-size:1.5rem;letter-spacing:.04em;color:var(--cream)}
#wtmap #wm-lvlHead .bar{height:4px;border-radius:3px;background:rgba(0,0,0,.55);overflow:hidden;border:1px solid rgba(var(--brass-rgb),.35)}
#wtmap #wm-lvlHead .bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--brass),var(--brass-hi));transition:width .6s}
#wtmap #wm-lvlHint{position:absolute;left:50%;top:46%;transform:translate(-50%,-50%);z-index:2;text-align:center;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:rgba(176,202,190,.55);display:none;line-height:1.7}
#wtmap #wm-lvl.noimg #wm-lvlHint{display:block}
#wtmap #wm-lvlWrap{position:absolute;left:0;right:0;bottom:max(14px,env(safe-area-inset-bottom));z-index:3;overflow-x:auto;overflow-y:hidden;padding:8px 0;scrollbar-width:none}
#wtmap #wm-lvlWrap::-webkit-scrollbar{display:none}
#wtmap #wm-lvlRoute{display:flex;align-items:flex-end;gap:22px;padding:6px max(16px,calc(50vw - 330px));min-width:max-content;position:relative}
#wtmap #wm-lvlRoute::before{content:"";position:absolute;left:0;right:0;bottom:36px;height:3px;background:linear-gradient(90deg,transparent,rgba(var(--brass-rgb),.35) 8%,rgba(var(--brass-rgb),.35) 92%,transparent);z-index:0}
#wtmap .lnode{position:relative;z-index:1;flex:0 0 auto;display:flex;flex-direction:column;align-items:center;gap:5px;background:none;border:0;padding:0;cursor:pointer;touch-action:manipulation;font-family:inherit}
#wtmap .lnode .in{width:52px;height:52px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:var(--serif);font-weight:700;font-size:18px;color:var(--cream);background:radial-gradient(120% 120% at 35% 25%,rgba(var(--brass-rgb),.22),#0D2E25 70%);border:2px solid rgba(var(--brass-rgb),.4);box-shadow:0 4px 10px rgba(0,0,0,.55);transition:transform .15s}
#wtmap .lnode:active .in{transform:scale(.94)}
#wtmap .lnode .lb{font-size:8px;letter-spacing:.08em;text-transform:uppercase;color:var(--cream);text-shadow:0 1px 4px #000,0 0 3px #000}
#wtmap .lnode.lock{cursor:default}
#wtmap .lnode.lock .in{border-color:rgba(0,0,0,.5);color:var(--faint);background:#071A15;box-shadow:none}
#wtmap .lnode.lock .lb{color:var(--muted)}
#wtmap .lnode.done .in{border-color:var(--brass);color:var(--brass-hi)}
#wtmap .lnode.cur .in{border-color:var(--brass-hi);box-shadow:0 0 0 4px rgba(var(--brass-rgb),.22),0 4px 14px rgba(0,0,0,.55);animation:wmlpulse 2.2s ease-in-out infinite}
@keyframes wmlpulse{0%,100%{box-shadow:0 0 0 4px rgba(var(--brass-rgb),.22),0 4px 14px rgba(0,0,0,.55)}50%{box-shadow:0 0 0 9px rgba(var(--brass-rgb),.1),0 4px 14px rgba(0,0,0,.55)}}
#wtmap .lnode.boss .in{width:66px;height:66px;font-size:22px;background:radial-gradient(120% 120% at 35% 25%,rgba(var(--brass-rgb),.32),#0D2E25 70%)}
#wtmap .lnode.boss .lb{color:var(--brass-hi)}
#wtmap #wm-lvlModal{position:absolute;inset:0;z-index:8;background:rgba(2,6,5,.5);display:flex;align-items:center;justify-content:center;opacity:0;pointer-events:none;transition:opacity .2s}
#wtmap #wm-lvlModal.show{opacity:1;pointer-events:auto}
#wtmap #wm-lvlModal .card{position:relative;width:min(440px,calc(100% - 32px));max-height:calc(100% - 24px);overflow:auto;background:linear-gradient(180deg,rgba(13,46,37,.97),rgba(7,26,21,.98));border:1px solid var(--brass);border-radius:16px;padding:16px 18px;box-shadow:0 14px 50px rgba(0,0,0,.7)}
#wtmap #wm-lvlModal .x{position:absolute;right:10px;top:8px;width:30px;height:30px;border-radius:50%;border:1px solid var(--line);background:none;color:var(--cream);font-size:18px;cursor:pointer}
#wtmap #wm-lvlModal small{font-size:9px;letter-spacing:.2em;text-transform:uppercase;color:var(--brass-hi)}
#wtmap #wm-lvlModal h3{margin:2px 0 6px;font-family:var(--serif);font-size:1.3rem;color:var(--cream)}
#wtmap #wm-lvlModal p{margin:0 0 10px;font-size:12.5px;line-height:1.5;color:var(--muted)}
#wtmap.in-city #wm-panel{display:none}
#wtmap #wm-devwrap{position:absolute;z-index:25;left:50%;bottom:max(8px,env(safe-area-inset-bottom));transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:5px}
#wtmap #wm-devbtn{font-size:9px;letter-spacing:.2em;color:var(--muted);background:rgba(2,6,5,.72);border:1px solid var(--line);border-radius:999px;padding:4px 12px;cursor:pointer}
#wtmap #wm-devmenu{display:none;gap:5px;flex-wrap:wrap;justify-content:center;max-width:min(440px,92vw);background:rgba(2,6,5,.94);border:1px solid var(--line);border-radius:12px;padding:7px}
#wtmap #wm-devmenu.show{display:flex}
#wtmap #wm-devmenu button{font-size:10.5px;background:var(--felt2);color:var(--cream);border:1px solid var(--line);border-radius:8px;padding:6px 9px;cursor:pointer}
#wtmap.in-country #wm-devwrap{left:calc(50% - min(150px,21vw))}
@media (max-height:430px){
#wtmap #wm-seat{padding:3px 9px 4px;min-width:112px}
#wtmap #wm-seat strong{font-size:15px}
#wtmap .grid{grid-template-columns:repeat(5,40px);justify-content:space-between;gap:3px 4px}
#wtmap .seats{margin-top:4px;gap:4px}
#wtmap .seats span{padding:1px 6px;font-size:8px}
#wtmap .ph small{font-size:8.5px}
#wtmap #wm-panel{padding:9px 12px}
#wtmap .ph h2{font-size:1.25rem}
#wtmap .games{margin:2px 0 4px}
#wtmap .cap{margin-top:5px;padding:5px 9px;min-height:0}
#wtmap .cap p{font-size:10.5px}
#wtmap .cta{margin-top:7px;min-height:38px}
}
@media (prefers-reduced-motion:reduce){
#wtmap .pulse{animation:none}
}`;

const NS='http://www.w3.org/2000/svg';
const $=id=>document.getElementById('wm-'+id);
const el=(n,a,p)=>{const e=document.createElementNS(NS,n);for(const k in (a||{}))e.setAttribute(k,a[k]);if(p)p.appendChild(e);return e;};
const MEMBER={closer:'the_closer',wildcard:'the_wildcard',optimist:'the_optimist',charmer:'the_charmer',sharp:'the_sharp',scholar:'the_scholar',jester:'the_jester'};
const GE={player:['You','YOU'],group:['The Great Eight','GE'],closer:['The Closer','CL'],wildcard:['The Wildcard','WI'],optimist:['The Optimist','OP'],charmer:['The Charmer','CH'],sharp:['The Sharp','SH'],scholar:['The Scholar','SC'],jester:['The Jester','JE']};
const EU=[
 {k:'IT',id:'380',name:'Italy',city:'Rome',games:'Scopa · Briscola · Burraco',lead:'closer'},
 {k:'ES',id:'724',name:'Spain',city:'Madrid',games:'Mus · Brisca',lead:'optimist'},
 {k:'PT',id:'620',name:'Portugal',city:'Porto',games:'Sueca',lead:'sharp'},
 {k:'NL',id:'528',name:'Netherlands',city:'Rotterdam',games:'Klaverjassen · Hartenjagen',lead:'charmer',off:[11,-9]},
 {k:'GB',id:'826',name:'United Kingdom',city:'London',games:'Cribbage · Whist · Black Maria',lead:'player',off:[-9,-3]},
 {k:'BE',id:'056',name:'Belgium',city:'Brussels',games:'Wiezen · Manillen · Schuppen Dam Jagen',lead:'wildcard',off:[-4,10]},
 {k:'DE',id:'276',name:'Germany',city:'Berlin',games:'Skat · Rummy',lead:'scholar'},
 {k:'PL',id:'616',name:'Poland',city:'Warsaw',games:'Kierki · Tysiąc',lead:'jester'},
 {k:'DK',id:'208',name:'Denmark',city:'Copenhagen',games:'Hjerterfri',lead:'group'},
 {k:'FR',id:'250',name:'France',city:'Paris',games:'Belote · Tarot · Dame de Pique',lead:'group'}
];
const EUID={};EU.forEach((c,i)=>{EUID[c.id]=i;});
const CONT={EU:'Europe',AF:'Africa',AS:'Asia',NA:'North America',SA:'South America',OC:'Oceania'};
const CORDER=['EU','AF','AS','NA','SA','OC'];
const PREVIEW_KEY={NA:'NORTH AMERICA',SA:'SOUTH AMERICA',AF:'AFRICA',AS:'ASIA',OC:'OCEANIA'};
const STAGE=[
 [1,3,'Arrival','The city, the local card scene, the first opponents.'],
 [4,6,'Contenders','Stronger players, rivalries, and who the Great Eight think is best.'],
 [7,8,'Final candidates','The strongest local players step forward.'],
 [9,9,'Champion decided','A story box crowns the national champion.'],
 [10,10,"The Keeper's Table",'You and two of the Great Eight face the new champion.']
];
const CTINT={IT:'#c07a45',ES:'#d9772b',PT:'#3d8fbf',NL:'#5a7fa0',GB:'#5a6672',BE:'#2f6a4a',DE:'#7a3a9a',PL:'#4a6078',DK:'#7fa8c4',FR:'#c9a24a'};

let root=null,D=null,dataLoading=null,svg,landG,routeG,marksG,imgW,imgE,paths=[];
let view={name:'continent',k:'EU',country:null},W=innerWidth,H=innerHeight,cam={minX:0,minY:0,u:1},anim=null;
let selNode=null,CITY=false,busy=false,devCleared=new Set();
/* ?wtdebug=1: a small on-screen log (bottom left) of what the map is doing, for diagnosing a phone problem from a screenshot. */
const DBG=/[?&]wtdebug=1/.test(location.search),dbgLines=[];
function dbg(m){
  if(!DBG)return;
  dbgLines.push(new Date().toISOString().slice(14,22)+' '+m);if(dbgLines.length>16)dbgLines.shift();
  let d=document.getElementById('wm-dbg');
  if(!d){d=document.createElement('pre');d.id='wm-dbg';d.style.cssText='position:fixed;left:4px;bottom:4px;z-index:2300;max-width:72vw;margin:0;padding:4px 6px;background:rgba(0,0,0,.82);color:#9f9;font:9px/1.25 monospace;pointer-events:none;white-space:pre-wrap';document.body.appendChild(d);}
  d.textContent=dbgLines.join(String.fromCharCode(10));
}
/* Countries whose level-select picture exists (public/campaign/worldtour/map/<cc>_select.webp): their tables are chosen on the city screen, the
   others on the side panel. Add a code when its picture arrives. */
const LVLPIC=['IT','ES','PT','NL','GB','BE','DE','PL','DK','FR'];
const hasPic=k=>LVLPIC.indexOf(k)>=0;

/* ---------- progress (see the header) ---------- */
function loadDev(){
  if(!window.WT_DEV) return;
  try{ JSON.parse(localStorage.getItem('ddp.wtDevCleared')||'[]').forEach(n=>devCleared.add(n)); }catch(e){}
  try{ JSON.parse(localStorage.getItem('ddp.wtDevSeen')||'[]').forEach(id=>campaignSeenCues.add(id)); }catch(e){}
}
function saveDevCleared(){ try{ localStorage.setItem('ddp.wtDevCleared',JSON.stringify(Array.from(devCleared))); }catch(e){} }
/* A table counts as cleared when the account's result for it says so (campaignData.wtResults, from the server: tables 401-500). In
   test mode (?wtdev=1) the device-only dev set counts too. */
const resultOf=n=>(typeof campaignData!=='undefined'&&campaignData&&campaignData.wtResults&&campaignData.wtResults[400+n])||null;
const isCleared=n=>!!(resultOf(n)&&resultOf(n).cleared)||(window.WT_DEV&&devCleared.has(n));
function tablesDone(i){let n=0;for(let t=1;t<=10;t++){if(isCleared(i*10+t))n=t;else break;}return n;}
const idxOf=k=>EU.findIndex(c=>c.k===k);
const tablesOf=k=>tablesDone(idxOf(k));
const doneCount=()=>EU.filter((c,i)=>tablesDone(i)>=10).length;
const euDone=()=>doneCount()===10;
const contDone=k=>campaignSeenCues.has('wtx_done_'+k);
const chosen=()=>CORDER.find(k=>k!=='EU'&&campaignSeenCues.has('wtx_cont_'+k)&&!contDone(k))||null;
const seats=()=>doneCount()+CORDER.filter(k=>k!=='EU'&&contDone(k)).length*10;
function cstate(i){if(tablesDone(i)>=10)return 'done';const f=EU.findIndex((x,j)=>tablesDone(j)<10);return i===f?'active':'locked';}
function contState(k){
  if(k==='EU')return euDone()?'done':'active';
  if(!euDone())return 'locked';
  if(contDone(k))return 'done';
  if(chosen())return chosen()===k?'active':'locked';
  return 'avail';
}
/* A story scene is on screen (the overlay is above this layer and covers it). `busy` alone is NOT trusted to block taps: if a scene ever
   failed to report that it finished, the whole map (nodes AND the back arrow) would stay dead. So taps are only blocked while the
   overlay is really visible, and story() always resolves: when the scene ends, throws, or has been off screen for 8 s. */
const storyOn=()=>{const e=document.getElementById('camp-prologue');return !!(e&&e.classList.contains('show'));};
const blocked=()=>busy&&storyOn();
const story=id=>new Promise(res=>{
  let fin=false;const t0=Date.now();
  const end=()=>{ if(!fin){ fin=true; clearInterval(w); res(); } };
  const w=setInterval(()=>{ if(!storyOn()&&Date.now()-t0>8000)end(); },1000);
  dbg('story '+id);
  try{ wtPlayStory(id,()=>{ dbg('story done '+id); end(); }); }catch(e){ console.error('story failed',e); dbg('story threw '+e.message); end(); }
});

/* ---------- camera ---------- */
function setVB(){svg.setAttribute('viewBox',cam.minX+' '+cam.minY+' '+(W*cam.u)+' '+(H*cam.u));imgE.style.opacity=Math.max(0,Math.min(1,(2900-W*cam.u)/1300));updateMarks();}
function fitBox(b,ins){
  const aw=W-ins.l-ins.r,ah=H-ins.t-ins.b,bw=b[2]-b[0],bh=b[3]-b[1];
  const u=Math.max(bw/aw,bh/ah),cx=(b[0]+b[2])/2,cy=(b[1]+b[3])/2;
  return {u,minX:cx-(ins.l+aw/2)*u,minY:cy-(ins.t+ah/2)*u};
}
const panelW=()=>Math.min(300,W*.42)+14;
function targetCam(v){
  const base={t:58,b:62,l:16,r:16};
  if(v.name==='world')return fitBox(D.vb.WORLD,{t:0,b:0,l:0,r:0});
  if(v.name==='continent'||v.name==='cont')return fitBox(D.vb[v.k],base);
  if(v.name==='country'){
    const b=D.cb[EU[idxOf(v.country)].id],pw=(b[2]-b[0])*.35,ph=(b[3]-b[1])*.35,m=Math.max(pw,ph);
    return fitBox([b[0]-m,b[1]-m,b[2]+m,b[3]+m],{t:58,b:22,l:16,r:panelW()+10});
  }
}
function flyTo(t,dur,done){
  if(!dur){cam.minX=t.minX;cam.minY=t.minY;cam.u=t.u;setVB();if(done)done();return;}
  const f={minX:cam.minX,minY:cam.minY,u:cam.u};
  const c0=[f.minX+W/2*f.u,f.minY+H/2*f.u],c1=[t.minX+W/2*t.u,t.minY+H/2*t.u];
  anim={t0:performance.now(),dur,f,t,c0,c1,done};
  requestAnimationFrame(tick);
}
function tick(now){
  if(!anim)return;
  const p=Math.min(1,(now-anim.t0)/anim.dur);const e=p<.5?4*p*p*p:1-Math.pow(-2*p+2,3)/2;
  const {f,t,c0,c1}=anim;
  const u=f.u*Math.pow(t.u/f.u,e);
  let s=e;if(Math.abs(1/t.u-1/f.u)>1e-9)s=(1/u-1/f.u)/(1/t.u-1/f.u);
  const cx=c0[0]+(c1[0]-c0[0])*s,cy=c0[1]+(c1[1]-c0[1])*s;
  cam.u=u;cam.minX=cx-W/2*u;cam.minY=cy-H/2*u;setVB();
  if(p<1)requestAnimationFrame(tick);else{const d=anim.done;anim=null;if(d)d();}
}
function updateMarks(){
  svg.querySelectorAll('#wm-marks [data-x]').forEach(g=>{g.setAttribute('transform','translate('+g.dataset.x+' '+g.dataset.y+') scale('+cam.u+')');});
}

/* ---------- map drawing ---------- */
const octPts=(r,rot)=>{let s=[];for(let i=0;i<8;i++){const a=(rot+45*i)*Math.PI/180;s.push((r*Math.cos(a)).toFixed(1)+','+(r*Math.sin(a)).toFixed(1));}return s.join(' ');};
const starPts=(ro,ri)=>{let s=[];for(let i=0;i<16;i++){const a=(22.5*i-90)*Math.PI/180,r=i%2?ri:ro;s.push((r*Math.cos(a)).toFixed(1)+','+(r*Math.sin(a)).toFixed(1));}return s.join(' ');};
function paintLand(){
  const v=view;
  paths.forEach(p=>{
    const c=p.dataset.c,id=p.dataset.id;let cls='land';
    if(v.name==='world'){cls+=' w-'+(c==='XX'?'x':contState(c));}
    else if(v.name==='continent'||v.name==='country'){
      if(c==='EU'&&id in EUID){const i=EUID[id];cls+=' k-'+cstate(i);if(v.country===EU[i].k)cls+=' k-sel';}
      else if(c==='EU')cls+=' nbr';else cls+=' far';
    }else if(v.name==='cont'){cls+=c===v.k?' k-pending':' far';}
    p.setAttribute('class',cls);
  });
}
const mkG=(x,y,cls,click)=>{const g=el('g',{class:'mk '+cls},marksG);g.dataset.x=x;g.dataset.y=y;if(click)g.addEventListener('click',click);return g;};
function lockIcon(g,y){el('path',{d:'M-5 '+(y-1)+'h10v8h-10z M-3 '+(y-1)+'v-3a3 3 0 0 1 6 0v3',fill:'none',stroke:'rgba(176,202,190,.7)','stroke-width':1.4},g);}
function renderMarks(){
  marksG.innerHTML='';routeG.innerHTML='';
  const v=view;
  if(v.name==='world'){
    CORDER.forEach(k=>{
      const [x,y]=D.lbl[k],st=contState(k);
      const g=mkG(x,y,st==='locked'?'locked':'',()=>tapContinent(k));
      el('circle',{r:26,fill:'transparent'},g);
      if(st==='done'){el('polygon',{points:octPts(15,22.5),fill:'url(#wmBrassG)',stroke:'#5a4520'},g);el('path',{d:'M-6 0l4 4 8-8',fill:'none',stroke:'#2a1e08','stroke-width':2.4,'stroke-linecap':'round'},g);}
      else if(st==='locked'){lockIcon(g,-3);}
      else{el('circle',{r:11,class:'pulse',fill:'none',stroke:'#EED08E','stroke-width':1.5},g);el('circle',{r:7,fill:st==='active'?'#EED08E':'rgba(196,158,88,.5)',stroke:'#EED08E'},g);}
      const t=el('text',{class:'lbl',y:30},g);t.textContent=CONT[k];
      const s=el('text',{class:'sub',y:42},g);
      s.textContent=k==='EU'?doneCount()+' / 10 champions':contDone(k)?'10 / 10 champions':(st==='active'?'in progress':st==='locked'?(euDone()?'finish '+CONT[chosen()]+' first':'after Europe'):'tap to begin');
    });
    return;
  }
  if(v.name==='cont')return;
  const pts=EU.map(c=>D.cities[c.k]);
  for(let i=0;i<pts.length-1;i++){
    el('path',{d:'M'+pts[i][0]+' '+pts[i][1]+'L'+pts[i+1][0]+' '+pts[i+1][1],class:tablesDone(i)>=10?'done':'todo'},routeG);
  }
  EU.forEach((c,i)=>{
    const st=cstate(i);
    if(v.name==='country'&&v.country!==c.k)return;
    const [x,y]=D.cities[c.k];
    const g0=mkG(x,y,st,()=>{if(v.name==='country'&&v.country===c.k&&hasPic(c.k)){tapCity(c.k);}else tapCountry(c.k);});
    const off=v.name==='country'?[0,0]:(c.off||[0,0]);   // nudge crowded Benelux/UK markers apart, like a printed atlas
    const g=el('g',{transform:'translate('+off[0]+' '+off[1]+')'},g0);
    el('circle',{r:26,fill:'transparent'},g);
    if(st==='done'){
      el('circle',{r:19,fill:'#0D2E25',stroke:'#EED08E','stroke-width':2},g);
      const t=el('text',{y:1,class:'num',fill:'#EED08E'},g);t.textContent=c.k;t.setAttribute('style','font-size:11px');
      el('circle',{cx:14,cy:-14,r:6.5,fill:'url(#wmBrassG)',stroke:'#5a4520'},g);
      el('path',{d:'M11 -14l2.2 2.2 4-4.4',fill:'none',stroke:'#2a1e08','stroke-width':1.8,'stroke-linecap':'round'},g);
    }else if(st==='active'){
      el('circle',{r:17,class:'pulse',fill:'none',stroke:'#EED08E','stroke-width':1.6},g);
      el('circle',{r:15,fill:'url(#wmBrassG)',stroke:'#5a4520','stroke-width':1.2},g);
      const t=el('text',{class:'num',fill:'#1c1405'},g);t.textContent=i+1;
    }else{
      el('circle',{r:11,fill:'#071A15',stroke:'rgba(176,202,190,.5)','stroke-width':1.3},g);
      const t=el('text',{class:'num',fill:'rgba(176,202,190,.8)',style:'font-size:10px'},g);t.textContent=i+1;
    }
    if(st!=='locked'||v.name==='country'){const l=el('text',{class:'lbl',y:(st==='done'?35:30)},g);l.textContent=c.city;}
  });
  updateMarks();
}

/* ---------- HUD / panels ---------- */
function toast(msg){const t=$('toast');t.textContent=msg;t.classList.add('show');clearTimeout(toast.h);toast.h=setTimeout(()=>t.classList.remove('show'),2600);}
function renderSeat(){
  $('seatn').innerHTML=seats()+'<span> / 60 seats</span>';
  const s=$('segs');s.innerHTML='';
  CORDER.forEach(k=>{const n=k==='EU'?doneCount():(contDone(k)?10:0);const i=document.createElement('i');const b=document.createElement('b');b.style.width=(n*10)+'%';i.appendChild(b);s.appendChild(i);});
}
function renderCrumb(){
  const v=view;let h='<b>World Tour</b>';
  if(v.name==='continent'||v.name==='cont')h+=' › <b>'+CONT[v.k]+'</b>';
  if(v.name==='country'){const c=EU[idxOf(v.country)];h='<b>Europe</b> › <b>'+c.name+'</b> · '+c.city;}
  $('crumb').innerHTML=h;
}
function renderProg(){
  const p=$('prog');
  if(view.name==='continent'||view.name==='cont'){
    p.style.display='block';const n=view.k==='EU'?doneCount():(contDone(view.k)?10:0);
    $('progk').textContent=CONT[view.k];
    $('progt').innerHTML='<b>'+n+' / 10</b> champions found';
    $('pips').innerHTML=Array.from({length:10},(_,i)=>'<i class="'+(i<n?'on':'')+'"></i>').join('');
  }else p.style.display='none';
}
const crown=c=>'<path d="M-7 -4l2.4 -6 4.6 4.4 4.6 -4.4 2.4 6z" fill="'+c+'" transform="translate(0 -3)"/>';
function nodeSVG(n,state){
  const w=n===9,k=n===10;
  let s='<svg viewBox="-26 -26 52 52">';
  if(k)s+='<polygon points="'+starPts(25,19)+'" fill="'+(state==='done'?'#806436':'none')+'" stroke="'+(state==='lock'?'rgba(196,158,88,.3)':'#EED08E')+'" stroke-width="1.2"/>';
  const num=(fill,weight)=>w?crown(fill)+'<text y="8" text-anchor="middle" font-family="IBM Plex Mono,monospace" '+weight+' font-size="14" fill="'+fill+'">9</text>'
    :'<text y="1" dominant-baseline="central" text-anchor="middle" font-family="IBM Plex Mono,monospace" '+weight+' font-size="'+(n>9?13:15)+'" fill="'+fill+'">'+n+'</text>';
  if(state==='done'){
    s+='<polygon points="'+octPts(21,22.5)+'" fill="url(#wmBrassG)" stroke="#5a4520" stroke-width="1.2"/><polygon points="'+octPts(16.5,22.5)+'" fill="none" stroke="#5a4520" stroke-width=".9"/>'+num('#2a1e08','font-weight="600"');
  }else if(state==='cur'){
    s+='<polygon points="'+octPts(23,22.5)+'" fill="none" stroke="#EED08E" stroke-width="1.4" class="pulse"/><polygon points="'+octPts(21,22.5)+'" fill="#0D2E25" stroke="#EED08E" stroke-width="2"/>'+num('#EED08E','font-weight="600"');
  }else{
    s+='<polygon points="'+octPts(21,22.5)+'" fill="#071A15" stroke="rgba(196,158,88,.28)" stroke-width="1.2"/>'+num('rgba(176,202,190,.55)','');
  }
  return s+'</svg>';
}
function leadBadge(c){
  const mid=MEMBER[c.lead];
  const src=mid&&wtPortraitSrc(mid,'neutral',wtLookFor(mid,c.k));
  return src?'<img class="lead-img" alt="" src="'+src+'">':'<div class="mono">'+GE[c.lead][1]+'</div>';
}
function renderPanel(){
  const p=$('panel');
  if(view.name!=='country'){p.classList.remove('show');return;}
  const c=EU[idxOf(view.country)],n=tablesOf(c.k),cur=Math.min(n+1,10),sel=selNode||cur;
  const ln=GE[c.lead][0];
  let h='<div class="ph"><div class="t"><small>'+c.name+'</small><h2>'+c.city+'</h2></div><div class="lead">'+leadBadge(c)+'lead cast</div></div>';
  h+='<div class="games">'+c.games+'</div><div class="grid">';
  for(let t=1;t<=10;t++){const st=t<=n?'done':(t===n+1?'cur':'lock');h+='<button class="nd'+(t===sel?' sel':'')+'" data-n="'+t+'" aria-label="Table '+t+'">'+nodeSVG(t,st)+'</button>';}
  h+='</div>';
  const sg=STAGE.find(s=>sel>=s[0]&&sel<=s[1]);
  h+='<div class="cap"><b>Table '+sel+' · '+sg[2]+'</b><p>'+sg[3]+'</p>';
  if(sel===10)h+='<div class="seats"><span class="you">You</span><span>Champion of '+c.name+'</span><span>'+ln+'</span><span>+1 Great Eight</span></div>';
  h+='</div>';
  if(hasPic(c.k))h+='<button class="cta" id="wm-playbtn">'+(n<10?'Enter '+c.city:'Enter '+c.city+' (cleared)')+'</button>';
  else if(n<10)h+='<button class="cta" id="wm-playbtn">Play table '+cur+'</button>';
  else h+='<button class="cta ghost" id="wm-backbtn">Back to Europe</button>';
  p.innerHTML=h;p.style.setProperty('--ct',CTINT[c.k]||'#C49E58');
  p.querySelectorAll('.nd').forEach(b=>b.addEventListener('click',()=>{selNode=+b.dataset.n;renderPanel();}));
  const pb=$('playbtn');if(pb)pb.addEventListener('click',()=>{if(hasPic(c.k))tapCity(c.k);else tryPlay(cur);});
  const bb=$('backbtn');if(bb)bb.addEventListener('click',()=>goView({name:'continent',k:'EU'}));
  p.classList.add('show');
  if(CITY)renderCityNodes();
}
function renderNote(){
  const n=$('note');
  if(view.name==='cont'){
    n.style.display='block';
    n.innerHTML='<b>'+CONT[view.k]+'</b>Ten countries and 100 tables will go here, drawn exactly like Europe. Not built yet.';
  }else n.style.display='none';
}
/* The shared attempts pool of the Hundred Tables (campaignData.attempts: available / max / next refill), shown on every view of the
   map (world, continent, country, city) like the Hundred Tables map does: chip + n/max + "Next in m:ss" while it is refilling. */
let attT=null;
function renderAttempts(){
  clearTimeout(attT);
  const el=$('att'); if(!el) return;
  const a=typeof campaignData!=='undefined'&&campaignData&&campaignData.attempts;
  if(!a){el.style.display='none';return;}
  el.style.display='';
  el.innerHTML=(typeof creditChipHTML==='function'?creditChipHTML(16):'')+'<span class="n">'+(a.unlimited?'∞':a.available+'/'+a.max)+'</span>'
    +'<span class="r" id="wm-attr"'+(a.nextRefillAt?' data-until="'+a.nextRefillAt+'"':'')+'></span>';
  tickAttempts();
}
function tickAttempts(){
  clearTimeout(attT);
  const r=document.getElementById('wm-attr'); if(!r||!root||!root.classList.contains('on'))return;
  const until=Number(r.dataset.until||0);
  if(!until){r.textContent='';return;}
  const left=Math.max(0,until-Date.now());
  if(left<=0){r.textContent='Refilling…';try{socket.emit('getCampaignState',{accountToken:accountToken||''});}catch(e){} return;}
  const m=Math.floor(left/60000),s=Math.floor((left%60000)/1000);
  r.textContent='Next in '+m+':'+String(s).padStart(2,'0');
  attT=setTimeout(tickAttempts,1000);
}
let attBound=false;
function bindAttempts(){
  if(attBound||typeof socket==='undefined')return; attBound=true;
  socket.on('campaignStateOk',()=>{ if(root&&root.classList.contains('on')) renderAttempts(); });
}
function renderAll(){paintLand();renderMarks();renderSeat();renderCrumb();renderAttempts();bindAttempts();renderProg();renderPanel();renderNote();renderDev();root.classList.toggle('in-country',view.name==='country');}

/* ---------- navigation ---------- */
function hideSheet(){$('sheet').classList.remove('show');}
function goView(v,opts){
  hideCity();
  opts=opts||{};hideSheet();
  view=v;selNode=null;
  renderAll();
  flyTo(targetCam(v),opts.instant?0:(opts.dur||1250),opts.done);
}
function tapContinent(k){
  const st=contState(k);
  if(!euDone()&&k!=='EU')return toast('Europe comes first — the tour starts in Rome.');
  if(k==='EU')return goView({name:'continent',k:'EU'});
  if(st==='locked')return toast('Finish '+CONT[chosen()]+' first — a continent is played to the end before the next.');
  if(st==='done')return goView({name:'cont',k});
  flyTo(fitBox(D.vb[k],{t:56,b:140,l:16,r:16}),1100);
  // Only a continent that has not been chosen yet has conversations. The one in progress goes straight to its sheet; a finished
  // continent (handled above) and Europe never play story again.
  (st==='avail'?previewContinent(k):Promise.resolve()).then(()=>showSheet(k,st==='active'));
}
/* World Map previews, before a continent is chosen: the 1st tap plays the full preview conversation, the 2nd tap the script's short
   "revisit" lines, and from the 3rd tap on nothing (straight to Begin / Not yet). `wt_world.preview.<X>` / `wt_world.revisit.<X>`
   are the seen markers. A chosen continent can only be left for one that is completely finished (contState: 'locked' otherwise). */
async function previewContinent(k){
  const name=PREVIEW_KEY[k],pre='world.preview.'+name,rev='world.revisit.'+name;
  const id=!wtStorySeen(pre)?pre:!wtStorySeen(rev)?rev:null;
  if(!id)return;
  busy=true;await story(id);busy=false;
}
function showSheet(k,resume){
  const s=$('sheet');
  s.innerHTML=resume?'<h3>'+CONT[k]+' — in progress</h3><p>Pick up where you left off.</p><div class="row"><button class="cta ghost" id="wm-shno">Back</button><button class="cta" id="wm-shyes">Continue</button></div>'
   :'<h3>Begin '+CONT[k]+'?</h3><p>10 countries · 100 tables · 10 champions. Once you start, finish all 100 tables before choosing another continent.</p><div class="row"><button class="cta ghost" id="wm-shno">Not yet</button><button class="cta" id="wm-shyes">Begin</button></div>';
  s.classList.add('show');
  $('shno').onclick=()=>{hideSheet();flyTo(targetCam({name:'world'}),900);};
  $('shyes').onclick=async()=>{
    hideSheet();
    if(!resume){wtMarkSeen('wtx_cont_'+k);busy=true;await story('world.commit');busy=false;}
    goView({name:'cont',k});
  };
}
function tapCountry(k){
  const i=idxOf(k),st=cstate(i);
  if(st==='locked'){const f=EU.findIndex((x,j)=>tablesDone(j)<10);return toast('Finish '+EU[f].city+' first.');}
  goView({name:'country',k:'EU',country:k});
  if(!hasPic(k))setTimeout(()=>playOpening(k),1300);   // with a city picture the opening plays once you step into the city
}
async function playOpening(k){
  dbg('playOpening '+k+' blocked='+blocked()+' seen='+wtStorySeen(k+'.open'));
  if(blocked()||wtStorySeen(k+'.open'))return;
  busy=true;await story(k+'.open');busy=false;renderPanel();
}

/* ---------- playing a table ---------- */
const curCountry=()=>EU[idxOf(view.country||'IT')];
/* The real thing: wtStartTable(absN) (defined once the World Tour levels are in server.js) starts the game; its result
   handler calls WTMAP.onTableCleared(absN). Until then only the DEV menu can clear a table. */
function tryPlay(n){
  const c=curCountry(),abs=idxOf(c.k)*10+n;
  if(n>tablesOf(c.k)+1)return;                       // the next table, or any cleared one (a replay)
  if(window.WT_DEV&&n===tablesOf(c.k)+1)return devClear();   // test mode: fake the clear instead of playing
  wtStartTable(abs);
}
async function afterClear(k,n){
  const c=EU[idxOf(k)],block=k+'.'+(idxOf(k)*10+n),first=!wtStorySeen(block);   // a replayed table shows neither its story nor the invitation again
  selNode=null;
  renderAll();
  busy=true;await story(block);busy=false;
  if(CITY)renderCityNodes();
  if(n===10&&first)setTimeout(()=>showInvite(c),250);
}
function showInvite(c){
  const m=$('modal');
  m.innerHTML='<small>The Keeper\'s Table · won</small><h2>'+c.name+' has its champion</h2>'
   +'<svg class="seal" viewBox="-50 -50 100 100"><polygon points="'+starPts(48,37)+'" fill="#806436"/><polygon points="'+octPts(34,22.5)+'" fill="url(#wmBrassG)" stroke="#5a4520"/><polygon points="'+octPts(27,22.5)+'" fill="none" stroke="#5a4520"/><text y="2" text-anchor="middle" dominant-baseline="central" font-family="Playfair Display,serif" font-weight="700" font-size="22" fill="#2a1e08">'+c.k+'</text></svg>'
   +'<p style="font-family:var(--serif);color:var(--brass-hi);letter-spacing:.06em">DAME DE PIQUE — WORLD TABLE INVITATION</p><p>National Champion: <b>'+c.name+'</b></p><p><i>Your seat is reserved.</i></p>'
   +'<button class="cta" id="wm-mcont">Continue</button>';
  $('scrim').classList.add('show');
  $('mcont').onclick=()=>{
    $('scrim').classList.remove('show');
    const idx=EU.indexOf(c);
    goView({name:'continent',k:'EU'},{done:async()=>{
      busy=true;await story(c.k+'.handoff');busy=false;
      if(euDone())return setTimeout(showEuropeDone,250);
      travel(idx);
    }});
  };
}
function travel(idx){
  const a=D.cities[EU[idx].k],b=D.cities[EU[idx+1].k];
  const g=el('g',{class:'trav'},marksG);const t=el('text',{'text-anchor':'middle','dominant-baseline':'central',fill:'#EED08E','font-size':20},g);t.textContent='♠';
  const t0=performance.now(),dur=1100;
  (function step(now){
    const p=Math.min(1,(now-t0)/dur),e=p*p*(3-2*p);
    const x=a[0]+(b[0]-a[0])*e,y=a[1]+(b[1]-a[1])*e-Math.sin(Math.PI*p)*cam.u*18;
    g.setAttribute('transform','translate('+x+' '+y+') scale('+cam.u+')');
    if(p<1)requestAnimationFrame(step);else{g.remove();toast(EU[idx+1].city+' is next.');}
  })(t0);
}
function showEuropeDone(){
  const m=$('modal');
  m.innerHTML='<small>Europe complete</small><h2>10 champions found</h2><div class="meds">'
   +EU.map(c=>'<div class="med"><div class="mono">'+c.k+'</div>'+c.city+'</div>').join('')+'</div>'
   +'<p>10 / 60 seats filled. The tour is bigger than it looked.</p><button class="cta" id="wm-mcont">Open the world map</button>';
  $('scrim').classList.add('show');
  $('mcont').onclick=()=>{$('scrim').classList.remove('show');goView({name:'world'},{dur:2200,done:()=>toast('EUROPE COMPLETE — 100 / 100 • WORLD CHAMPIONSHIP — 10 / 60')});};
}

/* ---------- city level select: the map zooms into the city, then fades into its picture with the tables as nodes ---------- */
function renderCityNodes(){
  if(!CITY)return;
  const c=curCountry(),n=tablesOf(c.k);
  $('lvlTitle').textContent=c.city;$('lvlSub').textContent=c.name+' · Tables 1–10';
  $('lvlBar').style.width=Math.min(100,n*10)+'%';
  let h='';
  for(let i=1;i<=10;i++){
    const st=i<=n?'done':(i===n+1?'cur':'lock'),boss=i===10;
    const inner=st==='lock'?'&#128274;':st==='done'?(boss?'&#9733;':'&#10003;'):String(i);
    h+='<button class="lnode '+st+(boss?' boss':'')+'" id="wm-lnode'+i+'" data-n="'+i+'" '+(st==='lock'?'disabled':'')+'><span class="in">'+inner+'</span><span class="lb">'+(boss?'Keeper\'s Table':'Table '+i)+'</span></button>';
  }
  $('lvlRoute').innerHTML=h;
  $('lvlRoute').querySelectorAll('.lnode').forEach(b=>b.addEventListener('click',()=>{if(!b.disabled)openLvlModal(+b.dataset.n);}));
  // centre the current node by scrolling ONLY the node row (scrollIntoView also scrolls every overflow:hidden ancestor, which can shift the whole layer)
  const cur=$('lnode'+Math.min(10,n+1)),wrap=$('lvlWrap');
  if(cur&&wrap){ wrap.scrollLeft=Math.max(0,cur.offsetLeft+cur.offsetWidth/2-wrap.clientWidth/2); }
}
/* Tapping a table opens the SAME popup as the Hundred Tables (objective, who sits at the table, best scores with friends' results once you
   have cleared it themselves, Play / Play Again): index.html's campaignOpenLevelModal, fed from campaignData.wtLevels. Without that data
   (test mode, no account) it falls back to a plain Play button. */
function openLvlModal(n){
  if(blocked())return;
  const c=curCountry(),abs=idxOf(c.k)*10+n;
  const has=typeof campaignData!=='undefined'&&campaignData&&(campaignData.wtLevels||[]).some(l=>l.id===400+abs);
  if(has&&typeof campaignOpenLevelModal==='function')return campaignOpenLevelModal(400+abs);
  const done=tablesOf(c.k),st=n<=done?'done':(n===done+1?'cur':'lock'),sg=STAGE.find(s=>n>=s[0]&&n<=s[1]);
  let h='<small>'+c.city+' · '+(n===10?'Boss table':'Table '+n)+'</small><h3>'+(n===10?"The Keeper's Table":'Table '+n+' · '+sg[2])+'</h3><p>'+sg[3]+'</p>';
  h+=st==='cur'?'<button class="cta" id="wm-lvlPlay">Play table '+n+'</button>':'<button class="cta" id="wm-lvlPlay">Play again</button><button class="cta ghost" id="wm-lvlClose2">Close</button>';
  $('lvlMBody').innerHTML=h;$('lvlModal').classList.add('show');
  const pl=$('lvlPlay');if(pl)pl.onclick=()=>{closeLvlModal();tryPlay(n);};
  const c2=$('lvlClose2');if(c2)c2.onclick=closeLvlModal;
}
function closeLvlModal(){$('lvlModal').classList.remove('show');}
function enterCity(k){
  dbg('enterCity '+k+' CITY='+CITY+' pic='+hasPic(k));
  return new Promise(res=>{
    if(!hasPic(k)||CITY){res();return;}
    $('lvlBg').innerHTML='<img alt="" src="/campaign/worldtour/map/'+k.toLowerCase()+'_select.webp">';
    CITY=true;root.classList.add('in-city');renderCityNodes();
    const [x,y]=D.cities[k];
    flyTo(fitBox([x-26,y-16,x+26,y+16],{t:0,b:0,l:0,r:0}),1000);                // zoom into Rome on the map ...
    setTimeout(()=>{$('lvl').classList.add('on');setTimeout(res,1100);},650);       // ... while the picture fades in over it
  });
}
function hideCity(){if(!CITY)return;CITY=false;closeLvlModal();root.classList.remove('in-city');$('lvl').classList.remove('on');}
async function tapCity(k){await enterCity(k);playOpening(k);}

/* ---------- dev (open the game with ?wtdev=1) ---------- */
function devClear(){
  if(blocked())return;
  const c=curCountry();
  if(!c||tablesOf(c.k)>=10)return;
  const n=tablesOf(c.k)+1;
  devCleared.add(idxOf(c.k)*10+n);saveDevCleared();
  afterClear(c.k,n);
}
function devReset(){
  devCleared.clear();saveDevCleared();
  Array.from(campaignSeenCues).forEach(id=>{if(/^wt[cx_]/.test(id)&&id.indexOf('wt_pro_')!==0)campaignSeenCues.delete(id);});
  try{localStorage.removeItem('ddp.wtDevSeen');}catch(e){}
  goView({name:'continent',k:'EU'},{instant:true});
}
function renderDev(){
  const w=$('devwrap');if(!w)return;
  w.style.display=window.WT_DEV?'flex':'none';
  if(!window.WT_DEV)return;
  const items=[['Clear next table',()=>{if(view.name==='country')devClear();else toast('Open a country first.');}],
   ['Skip: Europe done',()=>{for(let t=1;t<=100;t++)devCleared.add(t);saveDevCleared();goView({name:'continent',k:'EU'},{instant:true});setTimeout(showEuropeDone,200);}],
   ['World map',()=>{if(!euDone())return toast('Finish Europe first (use Skip).');goView({name:'world'});}],
   ['Reset (dev)',devReset],['Close',close]];
  if(view.name==='cont')items.splice(1,0,['Finish continent',()=>{wtMarkSeen('wtx_done_'+view.k);toast(CONT[view.k]+' complete — '+seats()+' / 60 seats filled.');goView({name:'world'},{dur:1800});}]);
  const m=$('devmenu');m.innerHTML='';
  items.forEach(([l,f])=>{const b=document.createElement('button');b.textContent=l;b.onclick=()=>{m.classList.remove('show');f();};m.appendChild(b);});
}

/* ---------- build, open, close ---------- */
function build(){
  if(root)return;
  const st=document.createElement('style');st.id='wm-css';st.textContent=CSS+'\n#wtmap{position:fixed;inset:0;z-index:2000;display:none;overflow:hidden;overflow:clip;color:var(--cream);font-family:var(--sans);background:radial-gradient(120% 90% at 50% 45%,#0d3a2d 0%,#071A15 55%,#020605 100%)}\n#wtmap.on{display:block}\n#wtmap::before{content:"";position:absolute;inset:0;z-index:8;pointer-events:none;background:radial-gradient(130% 110% at 50% 48%,transparent 55%,rgba(2,6,5,.42) 100%)}\n#wtmap::after{content:"";position:absolute;inset:6px;border:1px solid var(--line);border-radius:14px;pointer-events:none;z-index:9}';
  document.head.appendChild(st);
  root=document.createElement('div');root.id='wtmap';
  root.innerHTML='<svg id="wm-svg" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="wmBrassG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#EED08E"/><stop offset=".55" stop-color="#C49E58"/><stop offset="1" stop-color="#806436"/></linearGradient></defs>'
   +'<image id="wm-imgW" preserveAspectRatio="none"/><image id="wm-imgE" preserveAspectRatio="none" style="opacity:0"/><path id="wm-grat" class="grat"/><g id="wm-land"></g><g id="wm-route" class="route"></g><g id="wm-marks"></g></svg>'
   +'<div id="wm-top" class="hud"><button class="hbtn" id="wm-back" aria-label="Back">&#8249;</button><div id="wm-crumb"></div><div id="wm-att" aria-label="Attempts" style="display:none"></div><div id="wm-seat"><small>World Championship</small><strong id="wm-seatn">10<span> / 60 seats</span></strong><div id="wm-segs"></div></div></div>'
   +'<div id="wm-prog" class="hud" style="display:none"><small id="wm-progk">Europe</small><strong id="wm-progt"></strong><div id="wm-pips"></div></div>'
   +'<div id="wm-lvl"><div id="wm-lvlBg"></div><div id="wm-lvlShade"></div><div id="wm-lvlHead"><small id="wm-lvlSub"></small><h2 id="wm-lvlTitle"></h2><div class="bar"><i id="wm-lvlBar"></i></div></div><div id="wm-lvlWrap"><div id="wm-lvlRoute"></div></div><div id="wm-lvlModal"><div class="card"><button class="x" id="wm-lvlX" aria-label="Close">&times;</button><div id="wm-lvlMBody"></div></div></div></div>'
   +'<aside id="wm-panel"></aside><div id="wm-note"></div><div id="wm-sheet"></div><div id="wm-scrim"><div id="wm-modal"></div></div><div id="wm-toast"></div>'
   +'<div id="wm-devwrap" style="display:none"><div id="wm-devmenu"></div><div id="wm-devbtn">DEV</div></div>';
  document.body.appendChild(root);
  // The shared level popup and the out-of-attempts popup live inside #app (its own stacking context, z-index 1), which would put them
  // UNDER this layer: move them to the body so they open on top of the map.
  // THE STORY OVERLAY TOO (#camp-prologue): it lives inside #app, so its z-index 2100 only counts inside #app (z-index 1) and every scene played over the
  // open map (Rome's opening, the scenes after a table, the world-map conversations) rendered UNDER this layer: invisible and untappable, the scene
  // "running" behind the map. Body-level it sits above the map as intended.
  ['camp-prologue','camp-level-modal','camp-noattempts-modal'].forEach(id=>{ const e=document.getElementById(id); if(e&&e.parentNode!==document.body)document.body.appendChild(e); });
  svg=$('svg');landG=$('land');routeG=$('route');marksG=$('marks');imgW=$('imgW');imgE=$('imgE');
  $('devbtn').onclick=()=>$('devmenu').classList.toggle('show');
  $('lvlX').addEventListener('click',closeLvlModal);
  $('lvlModal').addEventListener('click',e=>{if(e.target.id==='wm-lvlModal')closeLvlModal();});
  $('back').addEventListener('click',()=>{
    if(storyOn()){ if(typeof campaignPrologueSkip==='function')campaignPrologueSkip(); return; }   // the back arrow always does something
    if(CITY){hideCity();flyTo(targetCam(view),900);return;}
    if(view.name==='country')return goView({name:'continent',k:'EU'});
    if(view.name==='cont')return goView({name:'world'});
    if(view.name==='continent'&&euDone())return goView({name:'world'});   // Europe finished: back to the world map, not out of the layer
    close();
  });
  landG.addEventListener('click',e=>{
    if(blocked())return;
    const p=e.target.closest('path');if(!p)return;const c=p.dataset.c,id=p.dataset.id;
    if(view.name==='world'){if(c!=='XX')tapContinent(c);}
    else if(view.name==='continent'&&c==='EU'&&id in EUID)tapCountry(EU[EUID[id]].k);
  });
  const showErr=m=>{ dbg('ERR '+m); if(!root||!root.classList.contains('on'))return; const t=$('toast'); t.textContent='Error: '+m; t.classList.add('show'); clearTimeout(toast.h); toast.h=setTimeout(()=>t.classList.remove('show'),9000); };
  addEventListener('error',e=>showErr(e.message+(e.filename?' ('+String(e.filename).split('/').pop()+':'+e.lineno+')':'')));
  addEventListener('unhandledrejection',e=>showErr(String((e.reason&&e.reason.message)||e.reason)));
  document.addEventListener('click',e=>{ if(DBG&&root&&root.classList.contains('on')){ const x=e.target; dbg('tap '+(x.id||x.className&&x.className.baseVal||x.className||x.tagName)+' busy='+busy+' story='+storyOn()+' city='+CITY); } },true);
  addEventListener('resize',()=>{if(!root.classList.contains('on'))return;dbg('resize '+innerWidth+'x'+innerHeight);W=innerWidth;H=innerHeight;anim=null;flyTo(targetCam(view),0);});
}
function loadData(){
  if(D)return Promise.resolve(D);
  if(!dataLoading)dataLoading=fetch('/campaign/worldtour/map-data.json?v=1').then(r=>r.json()).then(j=>{D=j;return j;}).catch(e=>{dataLoading=null;throw e;});
  return dataLoading;
}
function drawBase(){
  if(paths.length)return;
  $('grat').setAttribute('d',D.grat);
  [['world',imgW,'/campaign/worldtour/map/world_map.webp'],['europe',imgE,'/campaign/worldtour/map/europe_map.webp']].forEach(([k,e,src])=>{const b=D.img[k];e.setAttribute('x',b[0]);e.setAttribute('y',b[1]);e.setAttribute('width',b[2]);e.setAttribute('height',b[3]);e.setAttribute('href',src);});
  paths=D.polys.map(p=>{const e=el('path',{d:p.d,class:'land'},landG);e.dataset.c=p.c;e.dataset.id=p.id;return e;});
}
/* opts.afterPrologue: the prologue has just ended, so fly into Italy like the story says ("Then let's start there."). */
function open(opts){
  opts=opts||{};
  build();loadDev();
  return loadData().then(()=>{
    drawBase();
    W=innerWidth;H=innerHeight;busy=false;parked=false;resumed=false;unhold();
    root.classList.add('on');
    try{ cancelAnimationFrame(choiceGlobeRAF); }catch(e){}
    view=euDone()?{name:'world',k:null,country:null}:{name:'continent',k:'EU',country:null};
    renderAll();flyTo(targetCam(view),0);
    if(opts.afterPrologue&&!euDone())setTimeout(()=>tapCountry('IT'),900);
  }).catch(()=>{ window.toast('err-menu','Could not load the World Tour map.'); });
}
function close(){
  if(!root)return;
  hideCity();hideSheet();anim=null;busy=false;parked=false;resumed=false;unhold();
  $('scrim').classList.remove('show');
  root.classList.remove('on');
  try{ const sc=document.getElementById('camp-scene'); if(sc&&sc.classList.contains('choice-mode')&&typeof startChoiceGlobe==='function')startChoiceGlobe(); }catch(e){}
}
/* Starting a table: the map STAYS on screen (frozen) until the game screen is up, so the Campaign choice screen under it never shows for a
   moment; show() in index.html calls release() when the table screen appears, which hides the map but KEEPS its state (view, city, scroll).
   Coming back, back() puts that same map on screen at once, before the Campaign screen is even requested, and afterTable() then refreshes it
   with the new result. Safety: a hold that nothing releases ends after 8 s so the map is never left dead. */
let held=false,parked=false,resumed=false,holdT=null;
function hold(){
  if(!root||!root.classList.contains('on'))return;
  held=true;root.style.pointerEvents='none';clearTimeout(holdT);holdT=setTimeout(unhold,8000);
}
function unhold(){ held=false;clearTimeout(holdT);if(root)root.style.pointerEvents=''; }
function release(){
  if(!held||!root)return;
  unhold();parked=true;
  closeLvlModal();
  root.classList.remove('on');
}
function back(){
  if(!parked||!root)return false;
  parked=false;resumed=true;busy=false;
  try{ cancelAnimationFrame(choiceGlobeRAF); }catch(e){}
  root.classList.add('on');
  return true;
}
/* Back from a real game (index.html, campaignStateOk): reopen the map on that table's country and, when the table has just been
   cleared for the first time, play what follows it (progress first, then the story, then the next table opens). A failed
   attempt or a replay just returns to the city. */
function afterTable(absN,wasCleared){
  if(resumed&&root&&root.classList.contains('on')){            // the map came straight back from the table (back()): same view, same city, just refresh it
    resumed=false;
    try{ cancelAnimationFrame(choiceGlobeRAF); }catch(e){}
    const i=Math.floor((absN-1)/10),n=absN-i*10,k=EU[i].k;
    renderAll();renderCityNodes();
    if(isCleared(absN)&&!wasCleared)afterClear(k,n);
    return Promise.resolve();
  }
  resumed=false;
  return open().then(()=>{
    const i=Math.floor((absN-1)/10),n=absN-i*10,k=EU[i].k,go=()=>{ if(isCleared(absN)&&!wasCleared)afterClear(k,n); };
    goView({name:'country',k:'EU',country:k},{instant:true});
    if(hasPic(k))enterCity(k).then(go);else go();
  });
}
/* Play pressed in the shared level popup (abs = table 1-100 across Europe). */
function playTable(abs){
  const k=EU[Math.floor((abs-1)/10)].k;
  if(view.name!=='country'||view.country!==k)view={name:'country',k:'EU',country:k};
  tryPlay(abs-idxOf(k)*10);
}
window.WTMAP={open,close,hold,unhold,release,back,afterTable,playTable,notify:toast,isOpen:()=>!!root&&root.classList.contains('on')};
})();
