# Dashboard demo and media

Goal: add real screenshots and a short recording to both repositories, and publish a working public demo.

Assumptions: reuse the current dashboard design; the public demo uses synthetic sessions and browser-local state;
GitHub Pages hosts the static demo from the public repository. The installed localhost dashboard remains unchanged.

The plan is self-approved for autonomous execution because the owner requested media and a live test website,
and the implementation exposes only fixed sample data with no backend connection or credentials.

Acceptance and verification:
1. The demo reuses the dashboard assets and supports session details, ideas, assumptions, settings and reset.
   Verify with meaningful state tests and a real browser at desktop and mobile sizes.
2. Reload retains demo changes within that browser. Reset restores the sample data.
   Verify actions, reload and reset in the live browser.
3. No real local agent homes, credentials, transcripts or runtime stores enter the build or media.
   Verify the explicit asset build list, synthetic seed data, browser network traffic and secret scans.
4. Desktop/mobile screenshots and a short walkthrough show the actual demo.
   Inspect captured media and link it from both READMEs.
5. The public website is reachable over HTTPS and serves the committed source.
   Verify the Pages deployment commit, live assets, browser behavior and a release receipt.

Implementation: add demo data/transport, a zero-dependency asset builder and focused tests; capture media;
update documentation in both repositories; ship the Pages workflow separately from product changes.
Keep each commit within 15 files and 500 changed lines. Do not change the original checkout or installed agents.

Status: implementation pending.
