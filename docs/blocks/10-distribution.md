# Block 10 — Distribution

## Purpose

How people find Perch, install it, and learn what it does. The marketing
+ docs surface. Always free, MIT, RunCloud-aware.

## Files

- `web/` — landing page (perch.adityaarsharma.com)
- `docs/` — vision, install, automation, master-key, runcloud, safety,
  slack, telegram, webapp-modules-spec, **architecture (this directory)**
- `skills/perch/SKILL.md` — Claude Code skill (single-file install)
- `README.md` — repo entry point
- GitHub: `github.com/adityaarsharma/perch` (public, MIT)

## Current state

- ✅ Landing page live (terminal aesthetic, ambient parallax, magnetic CTA)
- ✅ Vision.md committed and aligned with build
- ✅ docs/ has 10+ markdown files covering each surface
- ✅ Claude Code skill (`SKILL.md`) installable
- ✅ MIT license, public repo
- ⚠️ README is thin — needs a "what Perch is in 30 seconds" section
- ❌ No demo video / GIF
- ❌ No RunCloud forum announcement (vision says "weekly mentions" target)
- ❌ No social presence (Twitter/Reddit/HN launch)

## Gaps (toward vision)

- [ ] One-line install command on landing: `curl -fsSL perch.adityaarsharma.com/install | bash`
- [ ] Claude Code one-shot: `claude /plugin install runcloud-server` —
  needs the plugin manifest format finalized
- [ ] 90-second demo GIF for the README
- [ ] RunCloud forum post (announce-style)
- [ ] Hacker News + Reddit r/selfhosted launch
- [ ] First 100 stars push (mailing list to friends + agencies)
- [ ] Submission to runcloud.io official addons page

## Next ship task

**Add a "30-second pitch" section to README.md** + record a 90-sec demo GIF
showing: monitor alert → tap fix → see result. The visual sells it more
than any docs paragraph. ~1h scripting + recording.

After that, RunCloud forum post — the vision's primary distribution
channel. The agencies who run RunCloud are the entire target audience.

## Boundaries

- All marketing copy stays in `docs/` and `web/`. Code-focused docs go in
  `blocks/`.
- "Always free, MIT, no SaaS" stays prominent — that's the wedge against
  paid competitors.
- No tracking on the landing page beyond plain server logs (vision says
  "your data stays on your hardware").
