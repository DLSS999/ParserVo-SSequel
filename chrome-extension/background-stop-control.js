// Reliable emergency stop for ParserVo Stone Island Capture.
// The legacy Stop handler only changed a local flag. This overlay also cancels
// every queued/running job for the connected shop and disables automatic polling.

chrome.runtime.onMessage.addListener((request) => {
  if (request?.action !== "stop") return;

  stopRequested = true;
  setCurrent("Stopping and cancelling queue");

  void chrome.storage.local.set({ autoQueue: false });

  void (async () => {
    try {
      const currentSettings = validate(await settings());
      const result = await queueRequest(currentSettings, {
        action: "cancel-current",
        message: "Stopped by user in Chrome Capture",
      }, 30000);
      log(`Stop confirmed by server; cancelled jobs ${Number(result?.cancelled || 0)}`);
      setCurrent("Stopped; automatic queue disabled");
    } catch (error) {
      log(`Server cancellation failed: ${messageOf(error)}`, true);
      setCurrent("Stopped locally; server cancellation failed");
    }
  })();
});
