# Design reference audit

Reviewed 2026-09-19 against [Refero's Dala reference](https://styles.refero.design/style/e5f5f8cf-e68d-4ed1-bbf5-6b67569af648), the local DESIGN.md, theme configuration, UI components, and the rendered landing page at desktop and 390px mobile widths.

## Assessment

SignLoop follows the reference's design language, with the product adaptations documented in DESIGN.md. It is not an exact reproduction of Dala's imagery or typography.

| Area | Finding |
| --- | --- |
| Palette | The seven Dala colours match the reference. Semantic UI colours resolve to these tokens or the documented product extensions. |
| Typography | Regular-weight headings, negative display tracking, and 18px/200 supporting copy follow the reference. Inter is loaded as its documented substitute; PPNeueMontreal files are not bundled. |
| Surfaces | Black canvas, transparent header, and shadowless cards retain the reference's restraint. Hairlines, raised overlays, and user-message bubbles are explicit SignLoop adaptations. |
| Actions | Violet pill buttons, ghost secondary actions, and outlined destructive actions follow the documented hierarchy. Duplicate filled actions in empty contract/project views were corrected. |
| Imagery | The canvas renders outlined multicoloured triangles with reduced-motion and offscreen handling. Its sparse, flatter brain silhouette is an approximation of the reference's much denser particle field. |
| Identity assets | The inline SignLoop mark and SVG site icon use the same triangle path and iris-to-verdant gradient. The repository also includes favicon and Apple icon variants. These are SignLoop identity assets, not a bundled Dala asset collection. |

## Corrections

- Prevented the empty landing view from auto-scrolling to the bottom as the headline grows, which hid its opening line on desktop. Conversations retain automatic scrolling.
- Changed the hero height calculation to use the dynamic viewport on mobile.
- Made header creation buttons outlined when an empty-state primary action is present.
- Corrected DESIGN.md and the Tailwind comment: v3 does not include spacing keys `4.5`, `7.5`, `15`, or `30`; explicit values are required for those Dala steps.

## Verification scope

Desktop and mobile landing layouts were checked in the browser. Saved workspace components were reviewed in source; authenticated contract, project, and chat flows were not exercised. Build, lint, type checks, and the existing unit suite validate the changes; database integration tests are outside this visual audit.
