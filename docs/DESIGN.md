# Web Markdown Workspace — Visual & Interaction Design

Status: V1.0 · 2026-10-15

## 1. Art direction
**Minimal, not bare.** Calm, precise and dense enough for technical work; the editor is the hero. Reference points: Linear's polish, Obsidian's layout, Milkdown Crepe's typography. Do not clone those products. A modern desktop workspace, not a card-based dashboard, landing page or Notion-style block interface.

Guiding attributes: **quiet, crisp, coherent, restrained, productive**.

### Avoid
Overlapping gradients, glassmorphism, giant rounded cards, bouncing animations, saturated status chips, ornamental illustrations, excessive icon buttons, large empty gutters, rainbow file icons, UI chrome competing with note body. Do not use random Tailwind colors from component to component.

## 2. Design tokens
Use CSS custom properties and shadcn-compatible semantic tokens; values below are *starting references*, adjust contrast in QA. Both themes are first-class. System theme by default, manual override persisted.

| Token | Light | Dark |
|---|---|---|
| `--background` | `#FFFFFF` | `#202124` |
| `--sidebar` | `#F7F7F8` | `#191A1C` |
| `--surface-hover` | `#EEEEEF` | `#303135` |
| `--border` | `#E7E7E9` | `#35363A` |
| `--foreground` | `#202124` | `#EEEEEE` |
| `--muted-foreground` | `#777B83` | `#A1A1A8` |
| `--accent` | `#5365B8` | `#94A8FF` |

Tokenize focus ring, destructive, selected, selection highlight, tooltip, scrollbar and code surfaces separately. Contrast must meet WCAG AA where feasible; adjust muted text when needed. Accent reserved for selected state, focus and links; not as background decoration.

### Product language
The default UI language is Simplified Chinese, including accessible labels, loading/error messages and editor menus. Code identifiers and API fields retain conventional technical naming. Necessary implementation comments and user-facing implementation notes are written in Chinese.

## 3. Typography
System UI: `Inter` when already installed, otherwise `system-ui, -apple-system, "Segoe UI", "Noto Sans CJK SC", sans-serif`; do **not** embed or redistribute font files. Chinese readability matters. Editor body: 15–16px, line-height ~1.7; comfortable Markdown text distinct from UI chrome. Interface: 12–13px secondary, 13–14px main; headers deliberate, not oversized. Code: system monospace, 13–14px. Numeric status uses tabular nums.

Editor prose measure: max width **760–820px** centered within the main pane, customizable eventually. Headings visually distinct; avoid huge vertical gaps. Markdown fenced code can expand inside document pane while retaining horizontal scroll.

## 4. Geometry and spacing
Spacing scale: 4px base (`4,8,12,16,20,24,32`). Sidebar default **240px**, resizable approximate range 200–360px. Top bar 40–44px, tabs 34–38px, Explorer row ~28–32px. Borders 1px low contrast. Typical radius 6px; popovers/dialogs 8–10px; avoid blanket 16–24px. Subtle shadows only on floating surfaces. Animations 120–180ms (opacity / translate 2–4px), honor reduced motion. Icons Lucide 15–18px, consistent stroke.

## 5. Desktop layout
```
┌────────────────────────────────────────────────────────────┐
│ Workspace                  Search             Theme  Settings│
├──────────────────┬─────────────────────────────────────────┤
│ EXPLORER         │ [PVE.md ×] [compose.yml ×]                │
│ ▾ Linux          ├─────────────────────────────────────────┤
│   ▾ PVE          │                                         │
│     PVE.md       │        # PVE GPU passthrough            │
│     compose.yml  │                                         │
│     screenshot   │        Observations ...                  │
│ ▸ Embedded       │                                         │
│ Inbox.md         │                                         │
├──────────────────┴─────────────────────────────────────────┤
│ main / Linux/PVE                              Saved · MD    │
└────────────────────────────────────────────────────────────┘
```

Top bar: one-line title, search affordance and compact controls. Avoid two competing navigation systems. Explorer: selected item uses muted tinted background and/or accent indicator, not filled primary-color pills. Tab strip quiet; modified tab has understated dot. Editor: generous internal margin, text dominates. Status line optional and discreet.

## 6. Components and behaviors
### File tree
Use disclosure arrows, small type-specific Lucide icons, ellipsis menu shown on hover **and keyboard focus**, clearly highlighted active file, hover affordance. Root and nested indentation consistent. Rename inline with validation and Escape cancel. Drag-and-drop with visible target and keyboard-accessible move action. Desktop drag moves one entry into a highlighted folder/root target, with hover expansion and no-overwrite errors. Touch and keyboard use the existing move menu. Arrow keys navigate visible rows; F2 renames and Delete opens confirmation. A large tree should use virtualization only after measured need.

### Tabs
One line, horizontal scroll; close button accessible. Closing dirty file should not destroy unsaved edits: flush save or preserve draft and disclose failure. Middle click optional. Limit unnecessary file-opening tabs via preview-tab behavior only if easy to understand.

The tablist contains only tabs. Pointer close marks remain inside each tab; Delete on the focused tab saves/closes it. A separate current-tab close button outside the tablist is available to assistive technology and becomes visible on focus, avoiding a duplicate permanent icon. Focus returns to the remaining active tab or Explorer toggle. Failed saves retain the tab. Rich/source mode controls form a named group.

### Editor
Milkdown Crepe default for Markdown. Preserve existing Crepe ergonomics; theme with scoped tokens rather than blanket CSS hacks. Floating toolbar, tables and code blocks must fit both dark/light themes. `Source` switch visible in file menu or toolbar. Always show subtle save state near document/tab; do not display toast on every save.

有损转换打开确认预览，复用版本比较窗口的双栏源码布局与移动端单栏布局，提供可展开的文本 Diff 和原文下载。初始焦点落在保留原文按钮，Escape/取消回到源码；确认按钮明确标识转换，不将预览视为同意保存。提示转换可能丢失语法或内容、确认后的自动保存及撤销历史限制。

### Modals, menus and search
shadcn/ui + Radix interaction semantics, consistent padding, keyboard focus rings, `Esc` to close. Quick-open command dialog has path secondary label and keyboard navigation. Search results show matching context without dense highlight noise. Confirmation only for destructive operations; routine saves are silent.

### Browser recovery
A quiet footer entry lists recoverable local records after authentication. Display source and disk text separately, with explicit paused restore, download and create-only copy actions. Never auto-apply a recovery record or replace an open dirty tab. Cache failure is a persistent, actionable notice; successful local caching is a subtle secondary status and never labeled as a completed disk save. Deleting a cache record requires confirmation.

### Upload
Paste/drop image into Markdown inserts relative link after upload succeeds. Show progress for larger uploads; retries and failures remain visible. File upload can use toolbar, context menu, and drop-zone cues rather than a giant permanent upload panel.

### Empty, loading and error states
Empty workspace: explain `Create note` and `Upload files` in one compact column. Empty directory: lightweight helper. Loading: unobtrusive skeleton in tree/editor, no blocking full-screen spinner. Offline/save error: sticky, actionable status, preserve edit buffer. 409/412 conflict: clearly distinguish local and remote versions; never overwrite on dismissal. External file changes keep the displayed buffer intact: clean files offer explicit reload (with undo reset disclosed), dirty files stop autosave and offer comparison/create-only copy. Missing original directories allow choosing a new copy path; failed copy attempts keep the dialog and draft.

## 7. Responsive behavior
Desktop >=1024px: Explorer + editor; 768–1023px: optionally collapsed Explorer; below ~768px: main editor full width and Explorer drawer. Mobile touch targets >=40px; contextual controls via visible overflow, not hover-only. No tiny fixed-width editor layout. On-screen keyboard must not cover save/error indicators. Below 768px the Explorer starts closed and opens as a modal drawer with focus trapping, backdrop/Escape close and focus return. Opening a document closes the drawer; other dialogs temporarily replace it. The visible viewport bounds the workbench/dialog height without disabling user zoom. Failed file-picker/camera uploads retain their original files in memory with explicit retry/download/discard actions. Mobile first use should not request installing an app.

## 8. Accessibility
Semantic landmarks; visible focus, useful accessible names, full keyboard path for create/open/rename/move/delete; dialog focus trapping and return, contrast testing in both themes, reduced-motion support. Indicate save status with polite ARIA live region at transitions but avoid announcement spam. Editor screen reader behavior validated separately; do not assume library defaults suffice.

Both editors describe Escape followed by Tab/Shift+Tab to leave editing keymaps. Dialog content captures opening focus before React input autoFocus, including windows without a Radix Trigger. The phone drawer does not steal focus when yielding to another dialog. Quick-open keeps keyboard focus on its combobox, with arrow-key option selection and no extra Tab stop per result. Current checks and assistive-technology limits are recorded in `QUALITY.md`.

## 9. UI build constraints for AI agents
- Implement design tokens first; use them everywhere.
- Reuse existing shadcn components; do not create competing button/dialog primitives.
- Each screen should look intentional at 1440×900, 1024×768 and 390×844.
- Avoid lorem ipsum in finished product; use representative filenames and documentation.
- New UI requires hover, focus, disabled, empty, loading, error and dark mode checks.
- Never substitute an elaborate dashboard for the core file tree/editor layout.
- Prefer removing visual elements before adding decoration.

## 10. Visual acceptance checklist
- At desktop width the document is visually dominant; left sidebar is useful but unobtrusive.
- Light/dark themes have matching hierarchy and readable contrast.
- Milkdown Crepe headings, blockquotes, tables, fenced code, selection and toolbars are consistently themed.
- Selected file, open tab and unsaved state are unambiguous without loud color.
- Mobile navigation, edit, upload and recoverable error handling work without hover.
- No unexpected horizontal scrolling of the entire application shell.
