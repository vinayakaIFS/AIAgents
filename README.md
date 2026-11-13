# Transaction Perf Recorder (Chrome / Edge extension)

Records a user's flow through a web application as **transactions** (page loads and user actions),
with the end-to-end response time of each transaction and of every HTTP request it caused.
Results are kept per session, summarised with average and 95th percentile, can be saved as a
**baseline**, and later sessions can be compared with that baseline. It also reports **Web Vitals** per page.

Nothing leaves the browser: all data is in `chrome.storage.local`.

## Install

1. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and select `C:\Exadata\PERF-AGENTS\Chrome\New_Chrome_Perf`.
3. Pin the extension (puzzle icon → pin).

To share it: run `powershell -File package.ps1`. It creates `dist\TxPerf-Recorder-<version>.zip`
for the Chrome Web Store, Edge Add-ons or an internal distribution. You can also use **Pack extension**
on `chrome://extensions` to build a `.crx`.

## Recording a session

1. Open the application in a tab, click the toolbar icon.
2. Enter a session name (for example `Order flow – 25R1 SU3`). Choose whether to reload the page first.
   **Reload (bypass cache)** gives a cold-cache start.
3. Click **Start recording this tab**. The badge shows the number of transactions captured.
4. Work through the flow. While recording you can:
   - **Name the next transaction.** The next action or page load gets your name, for example `03_Open_Customer_Order`.
     Stable names make runs comparable.
   - **Start / End a manual transaction.** Everything between the two clicks is one transaction,
     like `lr_start_transaction` / `lr_end_transaction`. The response time runs from Start to the end of the last request.
5. Click **Stop recording**. Open the **dashboard** to look at the results.

The popup lists the latest transactions. If you choose a baseline under **Compare live with**, it also shows the change for each one,
plus a running count of improved and degraded transactions.

### How transactions are detected

| Type | Starts | Ends |
|---|---|---|
| Page (navigation) | navigation start, or the click that triggered it (within 3 s) | load event fired **and** network quiet for 1 s |
| Action | click, Enter, `<select>` change or form submit (time of the user event) | network quiet for 1 s after the last request |
| Manual | **Start** in the popup | end of the last request (or **End** if there were none) |

- Response time = end − start. It includes every request the transaction caused: XHR, fetch, documents, scripts, CSS, images.
  It is the time the user waits until the screen has stopped loading.
- Actions that made no requests are dropped. You can change this in Settings.
- A new action closes the open transaction. Requests still in flight keep their transaction, and its end time moves when they finish.
- Requests open longer than 30 s (long polling, streaming) are flagged as *long* and do not hold the transaction open.
  WebSockets and analytics or beacon hosts are ignored. All of this is configurable.
- Names are built from the action and the page path. IDs, GUIDs, OData keys such as `(OrderNo='123')` and matrix parameters
  (`;$filter=…`) are collapsed, so the same step gets the same name in every run. Double-click a name in the
  Transactions tab to rename it in the selected sessions.
- Request timings come from `chrome.webRequest`: request start to response complete, including redirects and queueing.

## Flows and reruns

Every recording is kept as a **flow**: the start URL plus the ordered steps you performed. Steps include
pages opened, clicks, Enter, select changes, text typed into fields, form submits and manual transaction start/end.
Each step keeps several element locators (test ids, id, name, aria-label, title, link href, CSS path and visible text),
its think time and the name of the transaction it produced. The **Flows & reruns** tab lists them all.

- **Rerun a flow:** choose the number of iterations, the think time (as recorded, fixed or none), warm or cold cache,
  whether to stop at the first failed step and whether to close the tab afterwards, then click **Rerun flow**.
  - The rerun opens the start URL in a new tab. That first load warms up the tab and is not measured.
  - It then starts a recording with a reload and performs every enabled step.
  - It waits for each step's element (up to 20 s) and for the network to go quiet before the next step.
  - Transactions get the same names as in the recording, so every rerun compares 1:1 with it and with baselines.
  - Iterations run in the same session, so the averages and 95th percentiles cover all of them.
- **Runs table:** the recording and every rerun of the flow, with status, steps passed, transaction count, average,
  and the change vs the ★ reference run (total change, improved and degraded counts). Per run:
  - **View** opens the run in the other tabs.
  - **Compare** opens Baseline compare against the ★ run.
  - **★** makes the run the reference.
  - **Baseline** saves the run as a baseline.
  - **✕** removes a rerun from the flow. Its session is kept.
- **Trend across runs:** 95th pct (or average or median) of the transactions you tick, one point per run.
- **Steps:** untick steps to skip them, change think times, then click **Save step changes**.
- **Save ticked session as flow** makes a flow from an older session, for example with a different name.
  **Export / Import** moves flows between machines.
- While a rerun is in progress, a banner in the tab and the popup show the iteration, the step and a **Stop** button.
  Don't use the rerun tab until it finishes.

Notes:
- **Sign in first.** Password fields are never recorded, so a rerun starts from your current signed-in state.
- Typed text is stored in the flow so it can be replayed. Turn this off under Settings → *Record text typed into fields*.
- Reruns send synthetic DOM events. That works for standard controls and most single-page-app frameworks.
  A step fails with *Element not found* if no locator matches within the timeout. The run shows which step failed.
- Sessions recorded before version 1.1 have no steps and cannot be rerun.

## Dashboard

Tick one or more sessions on the left. Several ticked sessions are merged, for example three runs of the same flow.

- **Transactions:** count, average, 95th / 90th percentile, median, min, max, standard deviation, average requests, errors and size
  for each transaction. Sortable, filterable, CSV export.
- **Flows & reruns:** the flow library, described above.
- **Session flow:** the transactions in the order they happened, with time since start and think time. Click a row to see
  its request waterfall, with DOMContentLoaded and Load markers. Hover a bar for its details.
- **Requests:** every request, normalised and grouped (method + host + path + query parameter names). Filter by transaction.
  Requests made outside any transaction are listed separately.
- **Charts:** tick or untick transactions to show response time per execution (line chart, by execution number or elapsed time)
  and average vs 95th percentile (bar chart).
- **Baseline compare:** pick a baseline, the metric (95th pct, average, median, max) and the threshold (default: ±10 % **and** ±50 ms).
  The tab shows:
  - counts of improved, degraded, unchanged, new and missing transactions, plus a stacked bar
  - the total change
  - a comparison table
  - baseline vs current bars and a change (%) chart for the transactions you tick
  - the requests that changed most
  - Web Vitals vs baseline
- **Web Vitals:** p75 per page of TTFB, FCP, LCP, CLS, INP and TBT, coloured good / needs improvement / poor.
  It also shows DOMContentLoaded, Load, resource count, a loading-metrics chart and a table of every page view.
- **Settings:** quiet period, maximum transaction length, long-request cut-off, ignored resource types and URL patterns,
  the comparison defaults, and the flow options: keep every recording as a flow, record typed text, step timeout and
  maximum think time.

**Saving a baseline:** tick the reference session(s), type a name, click **Save as baseline**. The baseline keeps the raw samples, so
percentiles are recalculated exactly. Baselines remain when sessions are deleted. They can be exported and imported as JSON.

**Export:**
- **Export HTML report** creates a self-contained report with tables and charts: sessions, transactions, baseline comparison,
  Web Vitals per page, flow and slowest requests. It opens in any browser and prints to PDF.
- **Export JSON** exports the raw sessions. **Import JSON** accepts session and baseline exports.

## Web Vitals notes

- Collected in the top frame with `PerformanceObserver`. LCP stops at the first user input. CLS uses session windows (1 s gap, 5 s max).
  INP is the worst interaction, ignoring one in fifty. TBT is the sum of long-task time over 50 ms.
- A full page load is a *page load* view. Each SPA route change (URL change without reload) starts a *route change* view,
  which only has CLS, INP and TBT. LCP, FCP and TTFB only exist for full loads.
- Pages loaded before recording started are excluded. Use **Reload** on start to capture the first page.

## Files

```
manifest.json         MV3 manifest
background.js         service worker: session state, transaction detection, webRequest / webNavigation timing, flow rerun engine
content/content.js    user actions with locators, typed values, step playback for reruns, Web Vitals
lib/stats.js          percentiles, URL normalisation, aggregation, baseline comparison (shared)
lib/store.js          chrome.storage helpers and default settings (shared)
lib/flows.js          builds a flow (replayable steps) from a recorded session (shared)
lib/charts.js         dependency-free SVG charts (shared by dashboard and report)
popup/                toolbar popup: record / stop, transaction naming, live baseline comparison
dashboard/            dashboard page, Flows & reruns tab (flows-tab.js) and HTML report builder
icons/                toolbar icons
package.ps1           builds dist\TxPerf-Recorder-<version>.zip
test/                 dev harness (not packaged): mocks chrome.*, drives background.js with simulated
                      traffic, checks 29 capture, flow and rerun rules, then opens the real dashboard on the result.
                      Serve the folder over HTTP (python -m http.server) and open /test/harness.html.
```

## Limits

- One tab is recorded per session. Requests from service workers that are not tied to the tab are not counted.
- Request sizes come from the `Content-Length` header, so chunked or compressed responses without it show no size.
- If the service worker is restarted mid-transaction (rare, during long idle periods), that transaction is closed at its last
  completed request. Manual transactions stay open.
