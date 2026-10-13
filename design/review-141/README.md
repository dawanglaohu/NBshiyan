# #141 lighting review — screenshots (Refs #141 #109)
Captured 2026-10-13 from `pnpm build && pnpm start` on main (incl. #161), Chrome headless + Playwright, **SwiftShader software WebGL2 (ANGLE/Vulkan)**, 1440×1000, DPR 1.
Colours, shadows and tone mapping on a real GPU may differ; `gallery-*-1440.png` are full-page captures where the fixed WebGL canvas does not render (headless artifact, not a finding).
Findings: see the review issue linked from the PR.
