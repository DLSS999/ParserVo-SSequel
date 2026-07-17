// ParserVo Stone Island Capture 2.9.4
// A new service-worker filename prevents Chrome from reusing the stale 2.9.x
// worker that still enforced a fabricated required LOAD MORE click count.
importScripts(
  "background-stock.js",
  "background-stop-control.js",
  "background-loadmore-fix.js",
);
