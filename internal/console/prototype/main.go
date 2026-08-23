// PROTOTYPE — throwaway, never ship (round 5: header-strip card rail)
//
// Run: go run ./internal/console/prototype [workflow-name]
// Default workflow: prompt-enhance
//
// Step names: ID → derived label (herdr method / child workflow / run argv /
// agent prompt line) → "step N". Derived labels get a muted ·N index suffix.
//
// Raw YAML (variant 1 detail; y-toggle in 2/3) is hand-colored per line —
// comments, keys, list dashes, quoted strings, {{templates}}, bare scalars,
// block indicators — no lexer deps. Colorize after scroll clamp (line cuts only).
//
// Keys:
//
//	1 / 2 / 3     switch diagram variant
//	up / down     move step selection
//	left / right  move step selection (variant 3)
//	y             toggle inspector ↔ raw yaml (variants 2–3)
//	[ / ]         scroll yaml (variant 1; also pgup / pgdn)
//	s             toggle host: pane ↔ popup 85%
//	q / ctrl+c    quit
//
// Alt-screen: bubbletea v2 has no tea.WithAltScreen(); View.AltScreen = true.
package main

import (
	"fmt"
	"os"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

const (
	warnANSI  = 3
	mutedANSI = 8

	yamlKeyANSI      = 6
	yamlStringANSI   = 2
	yamlTemplateANSI = 5
	yamlScalarANSI   = 3

	hostPane  = "pane"
	hostPopup = "popup 85%"
	popupCols = 72

	railCols     = 34
	derivedCells = 24
)

func main() {
	name := "prompt-enhance"
	if len(os.Args) > 1 && strings.TrimSpace(os.Args[1]) != "" {
		name = strings.TrimSpace(os.Args[1])
	}
	cwd, err := os.Getwd()
	if err != nil {
		fmt.Fprintf(os.Stderr, "prototype: %v\n", err)
		os.Exit(1)
	}
	def, err := workflow.LoadWorkflow(name, cwd)
	if err != nil {
		fmt.Fprintf(os.Stderr, "prototype: load %s: %v\n", name, err)
		os.Exit(1)
	}
	diagram := workflow.ProjectDiagram(*def)
	yamlPath, err := resolveWorkflowYAML(name, cwd)
	if err != nil {
		fmt.Fprintf(os.Stderr, "prototype: yaml path: %v\n", err)
		os.Exit(1)
	}
	body, err := os.ReadFile(yamlPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "prototype: read %s: %v\n", yamlPath, err)
		os.Exit(1)
	}
	chunks := splitStepYAML(string(body))
	m := model{
		def:     def,
		diagram: diagram,
		chunks:  chunks,
		variant: 1,
		host:    hostPane,
		sel:     0,
		width:   80,
		height:  24,
	}
	if _, err := tea.NewProgram(m).Run(); err != nil {
		fmt.Fprintf(os.Stderr, "prototype: %v\n", err)
		os.Exit(1)
	}
}

func resolveWorkflowYAML(name, cwd string) (string, error) {
	for _, scope := range []string{"repo", "global"} {
		path, err := workflow.WorkflowPath(scope, cwd, name)
		if err != nil {
			return "", err
		}
		if _, err := os.Stat(path); err == nil {
			return path, nil
		}
	}
	return "", fmt.Errorf("workflow yaml for %q not found", name)
}

func splitStepYAML(body string) []string {
	lines := strings.Split(body, "\n")
	start := -1
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "steps:" || strings.HasPrefix(trimmed, "steps:") {
			start = i + 1
			break
		}
	}
	if start < 0 {
		return nil
	}
	var chunks []string
	var cur []string
	for _, line := range lines[start:] {
		if line != "" && !strings.HasPrefix(line, " ") && !strings.HasPrefix(line, "\t") {
			break
		}
		if strings.HasPrefix(line, "  - ") {
			if len(cur) > 0 {
				chunks = append(chunks, strings.Join(cur, "\n"))
			}
			cur = []string{line}
			continue
		}
		if len(cur) > 0 {
			cur = append(cur, line)
		}
	}
	if len(cur) > 0 {
		chunks = append(chunks, strings.Join(cur, "\n"))
	}
	return chunks
}

type model struct {
	def     *workflow.Definition
	diagram workflow.Diagram
	chunks  []string
	variant int
	host    string
	sel     int
	yamlOff int
	showRaw bool
	width   int
	height  int
}

func (m model) Init() tea.Cmd { return tea.RequestWindowSize }

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil
	case tea.KeyPressMsg:
		key := msg.String()
		switch key {
		case "ctrl+c", "q":
			return m, tea.Quit
		case "1", "2", "3":
			m.variant = int(key[0] - '0')
			m.yamlOff = 0
			return m, nil
		case "s":
			if m.host == hostPane {
				m.host = hostPopup
			} else {
				m.host = hostPane
			}
			return m, nil
		case "up":
			m.moveSel(-1)
			return m, nil
		case "down":
			m.moveSel(1)
			return m, nil
		case "left":
			if m.variant == 3 {
				m.moveSel(-1)
			}
			return m, nil
		case "right":
			if m.variant == 3 {
				m.moveSel(1)
			}
			return m, nil
		case "y":
			if m.variant == 2 || m.variant == 3 {
				m.showRaw = !m.showRaw
				m.yamlOff = 0
			}
			return m, nil
		case "[", "pgup":
			if m.variant == 1 && m.yamlOff > 0 {
				m.yamlOff--
			}
			return m, nil
		case "]", "pgdown", "pgdn":
			if m.variant == 1 {
				m.yamlOff++
				m.clampYAMLScroll()
			}
			return m, nil
		}
	}
	return m, nil
}

func (m *model) moveSel(delta int) {
	n := len(m.diagram.Nodes)
	if n == 0 {
		return
	}
	next := m.sel + delta
	if next < 0 {
		next = 0
	}
	if next >= n {
		next = n - 1
	}
	if next != m.sel {
		m.sel = next
		m.yamlOff = 0
	}
}

func (m *model) clampYAMLScroll() {
	lines := strings.Split(m.stepYAML(m.sel), "\n")
	vis := m.yamlVisibleLines()
	contentVis := vis
	if len(lines) > vis {
		contentVis = vis - 1
		if contentVis < 1 {
			contentVis = 1
		}
	}
	maxOff := len(lines) - contentVis
	if maxOff < 0 {
		maxOff = 0
	}
	if m.yamlOff > maxOff {
		m.yamlOff = maxOff
	}
	if m.yamlOff < 0 {
		m.yamlOff = 0
	}
}

func (m model) yamlVisibleLines() int {
	h := m.bodyHeight()
	vis := h - 1 // title row
	if vis < 1 {
		vis = 1
	}
	return vis
}

func (m model) bodyHeight() int {
	h := m.height - 2 // header + footer
	if m.host == hostPopup {
		h -= 2 // rounded border
	}
	if h < 4 {
		h = 4
	}
	return h
}

func (m model) View() tea.View {
	content := m.render()
	v := tea.NewView(content)
	v.AltScreen = true
	return v
}

func (m model) contentWidth() int {
	if m.host == hostPopup {
		return popupCols
	}
	if m.width > 0 {
		return m.width
	}
	return 80
}

func (m model) render() string {
	w := m.contentWidth()
	title := workflow.WorkflowDisplayTitle(m.def.Name, m.def.Title)
	header := fmt.Sprintf("PROTOTYPE #48 r5 · %s · variant %d/3 · host: %s", title, m.variant, m.host)
	headerLine := lipgloss.NewStyle().Reverse(true).Width(w).Render(truncate(header, w))

	var body string
	switch m.variant {
	case 2:
		body = m.renderRailInspector(w)
	case 3:
		body = m.renderFlowDetail(w)
	default:
		body = m.renderRailYAML(w)
	}

	footer := muted().Render(m.footerHints())
	inner := lipgloss.JoinVertical(lipgloss.Left, headerLine, body, footer)

	if m.host == hostPopup {
		return lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.ANSIColor(mutedANSI)).
			Width(w).
			Render(inner)
	}
	return inner
}

func (m model) footerHints() string {
	switch m.variant {
	case 2:
		return "1/2/3 variants · ↑↓ step · y yaml/inspector · s host · q quit"
	case 3:
		return "1/2/3 variants · ←→/↑↓ step · y yaml/inspector · s host · q quit"
	default:
		return "1/2/3 variants · ↑↓ step · [/] yaml scroll · s host · q quit"
	}
}

func (m model) leftWidth(w int) int {
	leftW := railCols
	if w < 50 {
		leftW = max(12, w/2)
	}
	return leftW
}

func (m model) rightWidth(w, leftW int) int {
	rightW := w - leftW - 1
	if rightW < 20 {
		rightW = 20
	}
	return rightW
}

func (m model) renderRail(leftW int) string {
	nodes := m.diagram.Nodes
	if len(nodes) == 0 {
		return muted().Render("(no steps)")
	}
	maxH := m.bodyHeight()
	type segment struct {
		text    string
		height  int
		cardIdx int // -1 = connector
	}
	var segs []segment
	for i, node := range nodes {
		if i > 0 {
			conn := centerRailConnectorBlock(leftW)
			segs = append(segs, segment{text: conn, height: lipgloss.Height(conn), cardIdx: -1})
		}
		card := m.railCard(node, i == m.sel, leftW)
		segs = append(segs, segment{text: card, height: lipgloss.Height(card), cardIdx: i})
	}

	selSeg := m.sel * 2
	start := selSeg
	end := selSeg + 1
	if end > len(segs) {
		end = len(segs)
	}
	segHeight := func(from, to int) int {
		total := 0
		for i := from; i < to; i++ {
			total += segs[i].height
		}
		return total
	}
	viewMax := maxH
	if segHeight(0, len(segs)) > maxH && maxH > 2 {
		viewMax = maxH - 2
	}
	for end < len(segs) && segHeight(start, end+1) <= viewMax {
		end++
	}
	for start > 0 && segHeight(start-1, end) <= viewMax {
		start--
	}

	above := 0
	for i := 0; i < start; i++ {
		if segs[i].cardIdx >= 0 {
			above++
		}
	}
	below := 0
	for i := end; i < len(segs); i++ {
		if segs[i].cardIdx >= 0 {
			below++
		}
	}

	var parts []string
	if above > 0 {
		parts = append(parts, muted().Render(fmt.Sprintf("… %d above", above)))
	}
	for i := start; i < end; i++ {
		parts = append(parts, segs[i].text)
	}
	if below > 0 {
		parts = append(parts, muted().Render(fmt.Sprintf("… %d below", below)))
	}
	return lipgloss.NewStyle().Width(leftW).Render(strings.Join(parts, "\n"))
}

func (m model) railCard(node workflow.DiagramNode, selected bool, cardW int) string {
	kind := nodeKind(node)
	color := kindColor(kind)
	innerW := cardW - 2
	if innerW < 4 {
		innerW = 4
	}

	textW := innerW - 2
	if textW < 1 {
		textW = 1
	}

	var bodyLines []string
	bodyLines = append(bodyLines, truncateStyled(m.stepTitle(node), textW))
	if len(node.When) > 0 {
		var clauses []string
		for _, c := range node.When {
			clauses = append(clauses, formatWhen(c))
		}
		whenLine := warn().Render("◇ " + strings.Join(clauses, "; "))
		bodyLines = append(bodyLines, truncateStyled(whenLine, textW))
	}
	if p := cardPlacementSummary(node.Placement); p != "" {
		bodyLines = append(bodyLines, truncateStyled(muted().Render(truncate(p, textW)), textW))
	}

	cornerTL, cornerTR, cornerBL, cornerBR, hbar, vbar := cardBorderChars(selected)
	kindStrip := lipgloss.NewStyle().Foreground(color).Render("[" + kind + "]")
	topInner := hbar + kindStrip
	topFill := innerW - lipgloss.Width(topInner)
	if topFill < 0 {
		topFill = 0
	}
	top := lipgloss.NewStyle().Foreground(color).Render(
		cornerTL + topInner + strings.Repeat(hbar, topFill) + cornerTR,
	)

	var rows []string
	rows = append(rows, top)
	for _, line := range bodyLines {
		padded := padStyledWidth(" "+line, innerW)
		rows = append(rows, lipgloss.NewStyle().Foreground(color).Render(vbar)+padded+lipgloss.NewStyle().Foreground(color).Render(vbar))
	}
	bottom := lipgloss.NewStyle().Foreground(color).Render(
		cornerBL + strings.Repeat(hbar, innerW) + cornerBR,
	)
	rows = append(rows, bottom)
	return strings.Join(rows, "\n")
}

func cardBorderChars(thick bool) (tl, tr, bl, br, h, v string) {
	if thick {
		return "╔", "╗", "╚", "╝", "═", "║"
	}
	return "┌", "┐", "└", "┘", "─", "│"
}

func cardPlacementSummary(p *workflow.DiagramPlacement) string {
	if p == nil {
		return ""
	}
	var parts []string
	if p.Open != "" {
		parts = append(parts, "pane:"+p.Open)
	}
	if p.Close != "" {
		parts = append(parts, "close:"+p.Close)
	}
	if p.Target != "" {
		parts = append(parts, "target:"+p.Target)
	}
	if p.Workspace != "" {
		parts = append(parts, "workspace:"+p.Workspace)
	}
	if p.Background {
		parts = append(parts, "bg")
	}
	return strings.Join(parts, " ")
}

func centerRailConnectorBlock(leftW int) string {
	pipe := centerRailConnector(leftW)
	arrow := centerMutedGlyph(leftW, "▼")
	return pipe + "\n" + arrow
}

func centerMutedGlyph(leftW int, glyph string) string {
	styled := muted().Render(glyph)
	gw := lipgloss.Width(styled)
	pad := (leftW - gw) / 2
	if pad < 0 {
		pad = 0
	}
	return strings.Repeat(" ", pad) + styled
}

func padStyledWidth(s string, w int) string {
	if lipgloss.Width(s) >= w {
		return truncateStyled(s, w)
	}
	return s + strings.Repeat(" ", w-lipgloss.Width(s))
}

func (m model) renderRailYAML(w int) string {
	nodes := m.diagram.Nodes
	if len(nodes) == 0 {
		return muted().Render("(no steps)")
	}
	leftW := m.leftWidth(w)
	rightW := m.rightWidth(w, leftW)
	left := m.renderRail(leftW)
	right := m.renderYAMLPane(rightW, m.yamlVisibleLines())
	return lipgloss.JoinHorizontal(lipgloss.Top, left, right)
}

func (m model) renderRailInspector(w int) string {
	nodes := m.diagram.Nodes
	if len(nodes) == 0 {
		return muted().Render("(no steps)")
	}
	leftW := m.leftWidth(w)
	rightW := m.rightWidth(w, leftW)
	left := m.renderRail(leftW)
	var right string
	if m.showRaw {
		right = m.renderYAMLPane(rightW, m.yamlVisibleLines())
	} else {
		right = m.renderInspectorPane(rightW)
	}
	return lipgloss.JoinHorizontal(lipgloss.Top, left, right)
}

func (m model) renderFlowDetail(w int) string {
	nodes := m.diagram.Nodes
	if len(nodes) == 0 {
		return muted().Render("(no steps)")
	}
	chain := m.renderFlowChain(w)
	var detail string
	if m.showRaw {
		detail = m.renderYAMLPaneBelow(w, m.bodyHeight()-lipgloss.Height(chain)-1)
	} else {
		detail = m.renderInspectorBelow(w)
	}
	return lipgloss.JoinVertical(lipgloss.Left, chain, detail)
}

func (m model) renderFlowChain(w int) string {
	nodes := m.diagram.Nodes
	boxes := make([]string, len(nodes))
	boxWidths := make([]int, len(nodes))
	for i, node := range nodes {
		boxes[i] = m.flowBox(node, i == m.sel)
		boxWidths[i] = lipgloss.Width(boxes[i])
	}
	conn := muted().Render("──►")
	connW := lipgloss.Width(conn)

	// Window so the selected box stays visible.
	start := 0
	for {
		total := 0
		for i := start; i < len(nodes); i++ {
			if i > start {
				total += connW
			}
			total += boxWidths[i]
		}
		if total <= w || start >= m.sel {
			break
		}
		start++
	}
	end := len(nodes)
	for end > start {
		total := 0
		for i := start; i < end; i++ {
			if i > start {
				total += connW
			}
			total += boxWidths[i]
		}
		if total <= w || end-1 <= m.sel {
			break
		}
		end--
	}

	var chainParts []string
	var botParts []string
	for i := start; i < end; i++ {
		if i > start {
			chainParts = append(chainParts, conn)
			botParts = append(botParts, strings.Repeat(" ", connW))
		}
		chainParts = append(chainParts, boxes[i])
		marker := ""
		if len(nodes[i].When) > 0 {
			marker = warn().Render("◇when")
		}
		pad := boxWidths[i] - lipgloss.Width(marker)
		if pad < 0 {
			pad = 0
		}
		botParts = append(botParts, marker+strings.Repeat(" ", pad))
	}
	top := lipgloss.JoinHorizontal(lipgloss.Center, chainParts...)
	bot := strings.Join(botParts, "")
	if lipgloss.Width(top) < w {
		top = lipgloss.NewStyle().Width(w).Render(top)
		bot = lipgloss.NewStyle().Width(w).Render(bot)
	}
	return top + "\n" + bot
}

func (m model) flowBox(node workflow.DiagramNode, selected bool) string {
	title := m.stepTitle(node)
	kind := nodeKind(node)
	color := kindColor(kind)
	border := lipgloss.NormalBorder()
	if selected {
		border = lipgloss.ThickBorder()
	}
	return lipgloss.NewStyle().
		Border(border).
		BorderForeground(color).
		Padding(0, 1).
		Render(title)
}

func (m model) renderYAMLPane(rightW, vis int) string {
	title := lipgloss.NewStyle().Bold(true).Render("step yaml")
	body := m.clippedYAML(m.sel, vis)
	inner := title + "\n" + body
	return lipgloss.NewStyle().
		Border(lipgloss.NormalBorder(), false, false, false, true).
		BorderForeground(lipgloss.ANSIColor(mutedANSI)).
		Padding(0, 0, 0, 1).
		Width(rightW).
		Render(inner)
}

func (m model) renderYAMLPaneBelow(w, vis int) string {
	if vis < 2 {
		vis = 2
	}
	title := lipgloss.NewStyle().Bold(true).Render("step yaml")
	body := m.clippedYAML(m.sel, vis-1)
	inner := title + "\n" + body
	return lipgloss.NewStyle().
		Border(lipgloss.NormalBorder(), true, false, false, false).
		BorderForeground(lipgloss.ANSIColor(mutedANSI)).
		Padding(0, 1).
		Width(w).
		Render(inner)
}

func (m model) clippedYAML(i, vis int) string {
	raw := m.stepYAML(i)
	lines := strings.Split(raw, "\n")
	if vis < 1 {
		vis = 1
	}
	off := m.yamlOff
	if off < 0 {
		off = 0
	}
	contentVis := vis
	if len(lines) > vis {
		contentVis = vis - 1
		if contentVis < 1 {
			contentVis = 1
		}
	}
	maxOff := len(lines) - contentVis
	if maxOff < 0 {
		maxOff = 0
	}
	if off > maxOff {
		off = maxOff
	}
	end := off + contentVis
	if end > len(lines) {
		end = len(lines)
	}
	// Colorize full chunk first (block-scalar indent state), then slice by line.
	colored := colorizeYAMLLines(lines)
	out := strings.Join(colored[off:end], "\n")
	remain := len(lines) - end
	if remain > 0 {
		out += "\n" + muted().Render(fmt.Sprintf("… (%d more)", remain))
	}
	return out
}

func centerRailConnector(leftW int) string {
	glyph := muted().Render("│")
	gw := lipgloss.Width(glyph)
	pad := (leftW - gw) / 2
	if pad < 0 {
		pad = 0
	}
	return strings.Repeat(" ", pad) + glyph
}

// colorizeYAMLLines applies prototype-grade line YAML highlighting.
// blockBase is the indent of the line that opened a |/> block (-1 = none).
func colorizeYAMLLines(lines []string) []string {
	blockBase := -1
	out := make([]string, len(lines))
	for i, line := range lines {
		out[i], blockBase = colorizeYAMLLine(line, blockBase)
	}
	return out
}

func colorizeYAMLLine(line string, blockBase int) (string, int) {
	if blockBase >= 0 {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			return line, blockBase
		}
		if leadingIndent(line) > blockBase {
			return line, blockBase
		}
		blockBase = -1
	}

	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return line, blockBase
	}
	if trimmed[0] == '#' {
		return ansiFg(mutedANSI, line), blockBase
	}

	return colorizeYAMLMappingLine(line, blockBase)
}

func colorizeYAMLMappingLine(line string, blockBase int) (string, int) {
	n := len(line)
	i := 0
	var b strings.Builder

	for i < n && (line[i] == ' ' || line[i] == '\t') {
		i++
	}
	b.WriteString(line[:i])

	if i+1 < n && line[i] == '-' && line[i+1] == ' ' {
		b.WriteString(ansiFg(mutedANSI, "- "))
		i += 2
		sp := i
		for i < n && (line[i] == ' ' || line[i] == '\t') {
			i++
		}
		b.WriteString(line[sp:i])
	}

	if i >= n {
		return b.String(), blockBase
	}
	if line[i] == '#' {
		b.WriteString(ansiFg(mutedANSI, line[i:]))
		return b.String(), blockBase
	}

	colon := findUnquotedColon(line, i)
	if colon >= 0 {
		b.WriteString(ansiFg(yamlKeyANSI, line[i:colon]))
		b.WriteString(ansiFg(mutedANSI, ":"))
		i = colon + 1
		sp := i
		for i < n && (line[i] == ' ' || line[i] == '\t') {
			i++
		}
		b.WriteString(line[sp:i])
		if i >= n {
			return b.String(), blockBase
		}
		val, next := colorizeYAMLValue(line[i:], leadingIndent(line))
		b.WriteString(val)
		return b.String(), next
	}

	val, next := colorizeYAMLValue(line[i:], leadingIndent(line))
	b.WriteString(val)
	return b.String(), next
}

func colorizeYAMLValue(val string, lineIndent int) (string, int) {
	lead := 0
	for lead < len(val) && (val[lead] == ' ' || val[lead] == '\t') {
		lead++
	}
	prefix := val[:lead]
	body := val[lead:]
	if body == "" {
		return prefix, -1
	}

	if ind, ok := blockIndicatorSpan(body); ok {
		rest := body[ind:]
		styled := ansiFg(yamlScalarANSI, body[:ind])
		if rest != "" {
			if strings.HasPrefix(strings.TrimSpace(rest), "#") {
				styled += ansiFg(mutedANSI, rest)
			} else {
				styled += colorizeTemplates(rest, -1)
			}
		}
		return prefix + styled, lineIndent
	}

	if body[0] == '"' || body[0] == '\'' {
		q := body[0]
		end := 1
		for end < len(body) {
			c := body[end]
			if q == '"' && c == '\\' && end+1 < len(body) {
				end += 2
				continue
			}
			if q == '\'' && c == '\'' && end+1 < len(body) && body[end+1] == '\'' {
				end += 2
				continue
			}
			if c == q {
				end++
				break
			}
			end++
		}
		quoted := colorizeTemplates(body[:end], yamlStringANSI)
		return prefix + quoted + colorizeAfterValue(body[end:]), -1
	}

	bare, after := splitBareValue(body)
	var styled string
	if isYAMLBareScalar(bare) {
		styled = ansiFg(yamlScalarANSI, bare)
	} else {
		styled = colorizeTemplates(bare, -1)
	}
	return prefix + styled + colorizeAfterValue(after), -1
}

func colorizeAfterValue(s string) string {
	if s == "" {
		return ""
	}
	trim := strings.TrimLeft(s, " \t")
	lead := s[:len(s)-len(trim)]
	if strings.HasPrefix(trim, "#") {
		return lead + ansiFg(mutedANSI, trim)
	}
	return colorizeTemplates(s, -1)
}

func splitBareValue(s string) (bare, after string) {
	inSingle, inDouble := false, false
	for i := 0; i < len(s); i++ {
		c := s[i]
		if inSingle {
			if c == '\'' {
				if i+1 < len(s) && s[i+1] == '\'' {
					i++
					continue
				}
				inSingle = false
			}
			continue
		}
		if inDouble {
			if c == '\\' && i+1 < len(s) {
				i++
				continue
			}
			if c == '"' {
				inDouble = false
			}
			continue
		}
		switch c {
		case '\'':
			inSingle = true
		case '"':
			inDouble = true
		case '#':
			if i == 0 || s[i-1] == ' ' || s[i-1] == '\t' {
				return s[:i], s[i:]
			}
		}
	}
	return s, ""
}

func blockIndicatorSpan(s string) (int, bool) {
	if s == "" || (s[0] != '|' && s[0] != '>') {
		return 0, false
	}
	i := 1
	if i < len(s) && (s[i] == '+' || s[i] == '-') {
		i++
	}
	j := i
	for j < len(s) && (s[j] == ' ' || s[j] == '\t') {
		j++
	}
	if j < len(s) && s[j] != '#' {
		return 0, false
	}
	return i, true
}

func isYAMLBareScalar(s string) bool {
	switch s {
	case "true", "false", "null", "True", "False", "Null", "TRUE", "FALSE", "NULL", "~":
		return true
	}
	return isNumberOrDuration(s)
}

func isNumberOrDuration(s string) bool {
	if s == "" {
		return false
	}
	i := 0
	if s[0] == '+' || s[0] == '-' {
		i++
		if i >= len(s) {
			return false
		}
	}
	digits := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
		digits++
	}
	if digits == 0 {
		return false
	}
	if i < len(s) && s[i] == '.' {
		i++
		frac := 0
		for i < len(s) && s[i] >= '0' && s[i] <= '9' {
			i++
			frac++
		}
		if frac == 0 {
			return false
		}
	}
	for i < len(s) && ((s[i] >= 'a' && s[i] <= 'z') || (s[i] >= 'A' && s[i] <= 'Z')) {
		i++
	}
	return i == len(s)
}

func findUnquotedColon(line string, start int) int {
	inSingle, inDouble := false, false
	for i := start; i < len(line); i++ {
		c := line[i]
		if inSingle {
			if c == '\'' {
				if i+1 < len(line) && line[i+1] == '\'' {
					i++
					continue
				}
				inSingle = false
			}
			continue
		}
		if inDouble {
			if c == '\\' && i+1 < len(line) {
				i++
				continue
			}
			if c == '"' {
				inDouble = false
			}
			continue
		}
		switch c {
		case '\'':
			inSingle = true
		case '"':
			inDouble = true
		case '#':
			return -1
		case ':':
			return i
		}
	}
	return -1
}

func colorizeTemplates(s string, baseANSI int) string {
	if s == "" {
		return ""
	}
	var b strings.Builder
	i := 0
	for i < len(s) {
		start := strings.Index(s[i:], "{{")
		if start < 0 {
			b.WriteString(paintBase(baseANSI, s[i:]))
			break
		}
		start += i
		b.WriteString(paintBase(baseANSI, s[i:start]))
		endRel := strings.Index(s[start:], "}}")
		if endRel < 0 {
			b.WriteString(ansiFg(yamlTemplateANSI, s[start:]))
			break
		}
		end := start + endRel + 2
		b.WriteString(ansiFg(yamlTemplateANSI, s[start:end]))
		i = end
	}
	return b.String()
}

func paintBase(baseANSI int, s string) string {
	if s == "" {
		return ""
	}
	if baseANSI < 0 {
		return s
	}
	return ansiFg(baseANSI, s)
}

func ansiFg(n int, s string) string {
	return lipgloss.NewStyle().Foreground(lipgloss.ANSIColor(n)).Render(s)
}

func leadingIndent(s string) int {
	i := 0
	for i < len(s) && (s[i] == ' ' || s[i] == '\t') {
		i++
	}
	return i
}

func (m model) renderInspectorPane(rightW int) string {
	inner := m.inspectorContent(m.sel)
	return lipgloss.NewStyle().
		Border(lipgloss.NormalBorder(), false, false, false, true).
		BorderForeground(lipgloss.ANSIColor(mutedANSI)).
		Padding(0, 0, 0, 1).
		Width(rightW).
		Render(inner)
}

func (m model) renderInspectorBelow(w int) string {
	inner := m.inspectorContent(m.sel)
	return lipgloss.NewStyle().
		Border(lipgloss.NormalBorder(), true, false, false, false).
		BorderForeground(lipgloss.ANSIColor(mutedANSI)).
		Padding(0, 1).
		Width(w).
		Render(inner)
}

func (m model) inspectorContent(i int) string {
	if i < 0 || i >= len(m.diagram.Nodes) {
		return muted().Render("(no step)")
	}
	node := m.diagram.Nodes[i]
	kind := nodeKind(node)
	color := kindColor(kind)
	name, derived := m.stepNameParts(node)
	badge := lipgloss.NewStyle().Reverse(true).Foreground(color).Render(" " + kind + " ")
	styled := lipgloss.NewStyle().Bold(true).Foreground(color).Render(name)
	if derived {
		styled += muted().Render(fmt.Sprintf(" ·%d", node.Index))
	}
	title := styled + "  " + badge

	keyStyle := muted()
	var sections []string
	sections = append(sections, title)

	if node.Label != "" {
		sections = append(sections, kvRow(keyStyle, "label", node.Label))
	}
	if len(node.When) > 0 {
		var clauses []string
		for _, c := range node.When {
			clauses = append(clauses, formatWhen(c))
		}
		sections = append(sections, kvRow(keyStyle, "when", warn().Render(strings.Join(clauses, "; "))))
	}
	if p := placementKV(node.Placement); p != "" {
		sections = append(sections, kvRow(keyStyle, "pane", p))
	}
	sections = append(sections, kvRow(keyStyle, "index", fmt.Sprintf("%d", node.Index)))
	return strings.Join(sections, "\n")
}

func kvRow(keyStyle lipgloss.Style, key, value string) string {
	return keyStyle.Render(padRight(key, 6)) + "  " + value
}

func placementKV(p *workflow.DiagramPlacement) string {
	if p == nil {
		return ""
	}
	var parts []string
	if p.Open != "" {
		parts = append(parts, "open:"+p.Open)
	}
	if p.Target != "" {
		parts = append(parts, "target:"+p.Target)
	}
	if p.Workspace != "" {
		parts = append(parts, "workspace:"+p.Workspace)
	}
	if p.Close != "" {
		parts = append(parts, "close:"+p.Close)
	}
	if p.Background {
		parts = append(parts, "bg")
	}
	return strings.Join(parts, " ")
}

func (m model) stepYAML(i int) string {
	if i < 0 || i >= len(m.chunks) {
		return "(no yaml chunk)"
	}
	return m.chunks[i]
}

func (m model) stepNameParts(node workflow.DiagramNode) (name string, derived bool) {
	if node.ID != "" {
		return node.ID, false
	}
	if label := m.derivedLabel(node); label != "" {
		return label, true
	}
	return fmt.Sprintf("step %d", node.Index), false
}

func (m model) stepTitle(node workflow.DiagramNode) string {
	name, derived := m.stepNameParts(node)
	if derived {
		return name + muted().Render(fmt.Sprintf(" ·%d", node.Index))
	}
	return name
}

func (m model) derivedLabel(node workflow.DiagramNode) string {
	if node.Label != "" {
		return node.Label
	}
	if m.def == nil {
		return ""
	}
	idx := node.Index - 1
	if idx < 0 || idx >= len(m.def.Steps) {
		return ""
	}
	switch action := m.def.Steps[idx].Action.(type) {
	case workflow.RunAction:
		if !action.Payload.IsArgv() {
			return ""
		}
		return truncate(strings.Join(action.Payload.Argv, " "), derivedCells)
	case workflow.AgentAction:
		line := firstNonEmptyLine(action.Prompt)
		if line == "" {
			return ""
		}
		return truncate(line, derivedCells)
	default:
		return ""
	}
}

func firstNonEmptyLine(s string) string {
	for _, line := range strings.Split(s, "\n") {
		if t := strings.TrimSpace(line); t != "" {
			return t
		}
	}
	return ""
}

func nodeKind(node workflow.DiagramNode) string {
	if node.Kind == "" {
		return "unknown"
	}
	return node.Kind
}

func formatWhen(clause workflow.WhenSpec) string {
	path := "{{" + clause.Path + "}}"
	if clause.Kind == workflow.WhenTruthy {
		return path
	}
	op := "=="
	if clause.Negate {
		op = "!="
	}
	return fmt.Sprintf("%s %s %q", path, op, clause.Value)
}

func kindColor(kind string) lipgloss.ANSIColor {
	switch kind {
	case "agent":
		return lipgloss.ANSIColor(6)
	case "run":
		return lipgloss.ANSIColor(2)
	case "herdr":
		return lipgloss.ANSIColor(5)
	case "workflow":
		return lipgloss.ANSIColor(4)
	default:
		return lipgloss.ANSIColor(7)
	}
}

func muted() lipgloss.Style {
	return lipgloss.NewStyle().Foreground(lipgloss.ANSIColor(mutedANSI))
}

func warn() lipgloss.Style {
	return lipgloss.NewStyle().Foreground(lipgloss.ANSIColor(warnANSI))
}

func truncate(s string, w int) string {
	if w <= 0 {
		return ""
	}
	runes := []rune(s)
	if len(runes) <= w {
		return s
	}
	if w <= 1 {
		return string(runes[:w])
	}
	return string(runes[:w-1]) + "…"
}

// truncateStyled truncates by visible width (ANSI-safe) for rail rows.
func truncateStyled(s string, w int) string {
	if w <= 0 {
		return ""
	}
	if lipgloss.Width(s) <= w {
		return s
	}
	return lipgloss.NewStyle().MaxWidth(w).Render(s)
}

func padRight(s string, n int) string {
	runes := []rune(s)
	if len(runes) >= n {
		return string(runes[:n])
	}
	return s + strings.Repeat(" ", n-len(runes))
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
