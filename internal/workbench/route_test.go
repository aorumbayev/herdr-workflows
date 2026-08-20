package workbench

import "testing"

func TestParseWebRouteAcceptsEditShareImport(t *testing.T) {
	want := func(kind, scope, name, hash string) *WebRoute {
		return &WebRoute{Kind: kind, Scope: scope, Name: name, Hash: hash}
	}
	cases := []struct {
		raw  string
		want *WebRoute
	}{
		{"w=repo:deploy", want("w", "repo", "deploy", "w=repo:deploy")},
		{"share=global:handoff", want("share", "global", "handoff", "share=global:handoff")},
		{"import", &WebRoute{Kind: "import", Hash: "import"}},
		{"new", &WebRoute{Kind: "new", Hash: "new"}},
		{
			"run=550e8400-e29b-41d4-a716-446655440000",
			&WebRoute{
				Kind: "run",
				ID:   "550e8400-e29b-41d4-a716-446655440000",
				Hash: "run=550e8400-e29b-41d4-a716-446655440000",
			},
		},
	}
	for _, tc := range cases {
		got := ParseWebRoute(tc.raw)
		if got == nil || *got != *tc.want {
			t.Fatalf("ParseWebRoute(%q) = %#v, want %#v", tc.raw, got, tc.want)
		}
	}
}

func TestParseWebRouteRejectsInvalid(t *testing.T) {
	for _, raw := range []string{
		"http://evil",
		"w=repo:../x",
		"w=other:name",
		"share=",
		"run=550e8400",
	} {
		if got := ParseWebRoute(raw); got != nil {
			t.Fatalf("ParseWebRoute(%q) = %#v, want nil", raw, got)
		}
	}
}

func TestAppendRouteHash(t *testing.T) {
	base := "http://127.0.0.1:7317/?token=abc"
	if got, want := AppendRouteHash(base, ParseWebRoute("import")), base+"#import"; got != want {
		t.Fatalf("import hash = %q, want %q", got, want)
	}
	if got, want := AppendRouteHash(base, ParseWebRoute("w=repo:x")), base+"#w=repo:x"; got != want {
		t.Fatalf("workflow hash = %q, want %q", got, want)
	}
	if got, want := AppendRouteHash(base, nil), base; got != want {
		t.Fatalf("nil route = %q, want %q", got, want)
	}
}
