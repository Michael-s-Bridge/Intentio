# Chrome Web Store listing — draft text

Reference copy for the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
submission form. Paste/adapt as needed; not part of the extension bundle.

## Short description (≤ 132 characters)

> Interrupts sites you haven't allowed with a quick re-anchoring prompt, so autopilot browsing doesn't win. Built for ADHD focus.

(130 characters — trim further if the dashboard counts differently.)

## Detailed description

> **Intentio** is a focus tool for ADHD-style autopilot browsing: instead of
> blocking distracting sites outright, it interrupts navigation to anything
> you haven't explicitly allowed and asks you a short set of questions —
> "What are you trying to accomplish?", "Is this what you're supposed to be
> doing?" — before letting you continue. The interrupt is the point: it's a
> deliberate pause designed to be hard to click through reflexively.
>
> **How it works**
> - Define an always-allowed list of sites that never interrupt you.
> - Customize the questions asked on every interrupt, including Yes/No
>   questions that branch into follow-up questions — edit them as a visual flowchart or as a simple
>   list.
> - A redirect log records what you were redirected from, what you
>   answered, and whether you stayed on track — viewable, sortable, and
>   exportable at any time.
> - A "Pause Intentio" button lets you temporarily disable interrupting
>   everywhere for a set number of minutes with a logged reason, for the
>   rare case you genuinely need to search across many tabs without
>   friction.
> - Tabs left open and forgotten re-trigger the interrupt after a
>   configurable idle period, so switching back to a stale distraction
>   doesn't slip past unnoticed.
>
> **Privacy**
> Everything Intentio stores stays on your own device, in the browser's
> local extension storage. There is no server, no analytics, and nothing is
> ever transmitted anywhere. Full privacy policy:
> https://michael-s-bridge.github.io/Intentio/docs/privacy-policy.html

## Category

Productivity

## Permission justifications

The dashboard asks for a short justification for each sensitive permission. Suggested answers:

**Host permissions (`<all_urls>`)**
> Intentio needs to see the destination URL of any page you navigate to, on
> any site, in order to decide whether that navigation should be
> interrupted with a re-anchoring prompt. It only reads the URL for this
> comparison — it does not read page content.

**`tabs`**
> Used to read a tab's current URL (to catch a tab left open and forgotten
> re-triggering the interrupt after an idle period) and to redirect a tab
> to the interrupt page.

**`webNavigation`**
> Used to detect same-page navigations on single-page-app sites (e.g. a
> new video on YouTube), which don't trigger a normal page load and would
> otherwise bypass the interrupt, and to know when a navigation has
> actually completed (versus being cancelled by the page itself).

**`declarativeNetRequest` / `declarativeNetRequestWithHostAccess` /
`declarativeNetRequestFeedback`**
> Used to redirect non-allowed navigations to the extension's own interrupt
> page, and to allow through sites on the user's configured allow-list.

**`storage`**
> Used to store the user's settings, questions, allow-list, and redirect
> log locally in the browser. Nothing is transmitted off the device.

**`alarms`**
> Used to schedule the expiry of temporary allowances (e.g. "skip this site
> for 30 minutes") and the "Pause Intentio" feature, so they end reliably
> even if the extension's background process was asleep when they were due.

## Screenshots

Chrome requires exactly 1280×800 or 640×400 (an 8:5 ratio) per screenshot.

- `screenshots/interrupt-page.png` — the interrupt page mid-question, 1280×800, ready to upload. The original was portrait (570×964), so it's centered on a white canvas with padding on both sides rather than cropped or stretched — legible, but with a fair amount of white space either side. Worth retaking in a wider window if a tighter fill is wanted later.
- `screenshots/flowchart-view.png` — the Settings page's flowchart view showing a branching (and converging) question set, 1280×800, ready to upload. Only thin padding top/bottom since the original was already close to the target ratio.

Still worth adding: the Log page showing a populated redirect log.
