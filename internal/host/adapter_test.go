package host

import (
	"strings"
	"testing"
)

func TestHerdrAdapterRequiresExplicitIdentities(t *testing.T) {
	err := ValidateHerdrInvocation("pane.split", map[string]any{"direction": "right"}, wholeTemplate)
	if err == nil || !strings.Contains(err.Error(), "target_pane_id") {
		t.Fatalf("omitted target = %v", err)
	}
	if err == nil || !strings.Contains(err.Error(), "never fall back to live herdr focus") {
		t.Fatalf("autofill message = %v", err)
	}
	reason, denied := MethodDeniedReason("server.stop")
	if !denied || reason == "" {
		t.Fatalf("denied reason = %q denied=%v", reason, denied)
	}
	if strings.Contains(strings.ToLower(reason), "security") {
		t.Fatalf("denylist must not claim security: %q", reason)
	}
	err = ValidateHerdrInvocation("server.stop", nil, wholeTemplate)
	if err == nil || !strings.Contains(err.Error(), reason) {
		t.Fatalf("denied invocation = %v", err)
	}
}

func TestAllowedGeneratedMethodsAreClassified(t *testing.T) {
	for name, entry := range herdrMethods {
		if entry.denied != "" {
			continue
		}
		if _, ok := herdrFocusPolicy[name]; !ok {
			t.Errorf("%s is allowed but unclassified (would autofill or fail closed only at call time)", name)
		}
	}
}
