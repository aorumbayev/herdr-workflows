package console

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/history"
)

func TestDetailScrollClampsAtBottom(t *testing.T) {
	log := make([]string, 20)
	for i := range log {
		log[i] = "log line " + strings.Repeat("x", i)
	}
	m := New(Options{
		Width:  80,
		Height: 12,
		LoadRuns: func() []history.Summary {
			return []history.Summary{{
				ID:       "11111111-1111-4111-8111-111111111111",
				Workflow: "demo",
				Status:   "succeeded",
			}}
		},
		LoadDetail: func(string) DetailPayload {
			return DetailPayload{Workflow: "demo", LogLines: log}
		},
	})
	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyTab})
	m = next.(Model)
	next, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(Model)
	if m.screen != screenDetail {
		t.Fatalf("screen = %v want detail", m.screen)
	}
	for range 30 {
		next, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyDown})
		m = next.(Model)
	}
	atBottom := m.detailScroll
	next, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyDown})
	m = next.(Model)
	if m.detailScroll != atBottom {
		t.Fatalf("extra down moved scroll %d -> %d", atBottom, m.detailScroll)
	}
	next, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyUp})
	m = next.(Model)
	if m.detailScroll >= atBottom {
		t.Fatalf("up after bottom clamp must decrease: %d", m.detailScroll)
	}
}
