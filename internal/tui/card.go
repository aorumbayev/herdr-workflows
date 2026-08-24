package tui

import (
	"fmt"
	"strings"

	"charm.land/lipgloss/v2"
)

const railCols = 36

type CardSpec struct {
	Kind     string
	Title    string
	Body     []string
	Focused  bool
	Selected bool
	Muted    bool
}

type RailHit struct {
	Index  int
	Y0, Y1 int
	X0, X1 int
}

type railSeg struct {
	text string
	h    int
	hit  RailHit
}

func RailSplit(width int) (leftW, rightW int) {
	if width <= 0 {
		width = 80
	}
	leftW = railCols
	if width < 50 {
		leftW = max(12, width/2)
	}
	if leftW > width-12 {
		leftW = max(12, width-12)
	}
	rightW = width - leftW - 1
	if rightW < 10 {
		rightW = 10
		leftW = max(8, width-rightW-1)
	}
	return leftW, rightW
}

func JoinRail(left, right string, leftW, height int) string {
	railLines := strings.Split(left, "\n")
	paneLines := strings.Split(right, "\n")
	n := max(len(railLines), len(paneLines), height)
	rows := make([]string, 0, n)
	for i := 0; i < n; i++ {
		l, r := "", ""
		if i < len(railLines) {
			l = railLines[i]
		}
		if i < len(paneLines) {
			r = paneLines[i]
		}
		rows = append(rows, padPlain(l, leftW)+" "+r)
	}
	if height > 0 && len(rows) > height {
		rows = rows[:height]
	}
	return strings.Join(rows, "\n")
}

func cardSegments(cards []CardSpec, leftW int) []railSeg {
	theme := DefaultTheme()
	var segs []railSeg
	for i, spec := range cards {
		if i > 0 {
			conn := theme.Muted.Render(centerPlain(leftW, "│")) + "\n" + theme.Muted.Render(centerPlain(leftW, "▼"))
			segs = append(segs, railSeg{text: conn, h: 2})
		}
		card := RenderCard(spec, leftW)
		h := lipgloss.Height(card)
		segs = append(segs, railSeg{text: card, h: h, hit: RailHit{Index: i, Y1: h}})
	}
	return segs
}

func RenderRail(cards []CardSpec, leftW, height, scroll int) (string, []RailHit) {
	theme := DefaultTheme()
	if len(cards) == 0 {
		return theme.Muted.Render("(no steps)"), nil
	}
	segs := cardSegments(cards, leftW)
	start, end := windowSegs(segs, height, scroll)
	var hits []RailHit
	var parts []string
	y := 0
	above := countCards(segs[:start])
	below := countCards(segs[end:])
	if above > 0 {
		parts = append(parts, theme.Muted.Render(fmt.Sprintf("... %d above", above)))
		y++
	}
	for i := start; i < end; i++ {
		if i%2 == 0 {
			hit := segs[i].hit
			hit.Y0 = y
			hit.Y1 = y + segs[i].h
			hits = append(hits, hit)
		}
		parts = append(parts, segs[i].text)
		y += segs[i].h
	}
	if below > 0 {
		parts = append(parts, theme.Muted.Render(fmt.Sprintf("... %d below", below)))
	}
	return strings.Join(parts, "\n"), hits
}

func RailScrollIntoView(cards []CardSpec, focus, leftW, height, scroll int) int {
	segs := cardSegments(cards, leftW)
	if len(segs) == 0 {
		return 0
	}
	slot := min(focus*2, len(segs)-1)
	start, end := windowSegs(segs, height, scroll)
	if slot < start {
		return slot
	}
	if slot < end {
		return scroll
	}
	for next := start + 1; next < len(segs); next++ {
		if _, e := windowSegs(segs, height, next); slot < e {
			return next
		}
	}
	return len(segs) - 1
}

func windowSegs(segs []railSeg, height, scroll int) (int, int) {
	if height <= 0 || len(segs) == 0 {
		return 0, len(segs)
	}
	viewMax := height
	total := 0
	for _, s := range segs {
		total += s.h
	}
	if total > height && height > 2 {
		viewMax = height - 2
	}
	heightOf := func(from, to int) int {
		n := 0
		for i := from; i < to; i++ {
			n += segs[i].h
		}
		return n
	}
	start := scroll
	if start < 0 {
		start = 0
	}
	if start >= len(segs) {
		start = len(segs) - 1
	}
	end := start + 1
	for end < len(segs) && heightOf(start, end+1) <= viewMax {
		end++
	}
	for start > 0 && heightOf(start-1, end) <= viewMax {
		start--
	}
	return start, end
}

func RenderCard(spec CardSpec, cardW int) string {
	kind := spec.Kind
	if kind == "" {
		kind = "step"
	}
	theme := DefaultTheme()
	color := theme.KindStyle(kind)
	innerW := cardW - 2
	if innerW < 4 {
		innerW = 4
	}
	textW := innerW - 2
	if textW < 1 {
		textW = 1
	}
	title := Truncate(selectMark(spec.Muted, spec.Selected, theme)+spec.Title, textW)
	lines := []string{title}
	for _, line := range spec.Body {
		clipped := Truncate(line, textW)
		if strings.HasPrefix(line, "when:") {
			lines = append(lines, theme.Warn.Render(clipped))
			continue
		}
		lines = append(lines, theme.Muted.Render(clipped))
	}
	tl, tr, bl, br, hbar, vbar := "┌", "┐", "└", "┘", "─", "│"
	if spec.Focused {
		tl, tr, bl, br, hbar, vbar = "╔", "╗", "╚", "╝", "═", "║"
	}
	kindBit := "[" + kind + "]"
	fill := innerW - lipgloss.Width(hbar+kindBit)
	if fill < 0 {
		fill = 0
	}
	top := color.Render(tl+hbar) + kindBit + color.Render(strings.Repeat(hbar, fill)+tr)
	rows := []string{top}
	for _, line := range lines {
		rows = append(rows, color.Render(vbar)+padPlain(" "+line, innerW)+color.Render(vbar))
	}
	rows = append(rows, color.Render(bl+strings.Repeat(hbar, innerW)+br))
	return strings.Join(rows, "\n")
}

func selectMark(muted, selected bool, theme Theme) string {
	if muted {
		return theme.Muted.Render("[-] ")
	}
	if selected {
		return "[x] "
	}
	return "[ ] "
}

func centerPlain(width int, s string) string {
	pad := (width - lipgloss.Width(s)) / 2
	if pad < 0 {
		pad = 0
	}
	return strings.Repeat(" ", pad) + s
}

func padPlain(s string, w int) string {
	n := lipgloss.Width(s)
	if n >= w {
		return Truncate(s, w)
	}
	return s + strings.Repeat(" ", w-n)
}

func countCards(segs []railSeg) int {
	n := 0
	for i := range segs {
		if i%2 == 0 {
			n++
		}
	}
	return n
}
