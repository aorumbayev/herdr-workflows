package host

import (
	"fmt"
	"math"
	"strings"
	"testing"
)

func TestCheckHerdrStartupProtocolMismatch(t *testing.T) {
	res := CheckHerdrStartup(float64(Protocol+1), MinHerdrVersion)
	if res.Ok {
		t.Fatal("expected protocol mismatch to fail")
	}
	for _, want := range []string{
		"connected=" + fmt.Sprint(Protocol+1),
		"pinned=" + fmt.Sprint(Protocol),
		"installed=" + MinHerdrVersion,
		"required≥" + MinHerdrVersion,
	} {
		if !strings.Contains(res.Error, want) {
			t.Errorf("error %q missing %q", res.Error, want)
		}
	}
}

func TestCheckHerdrStartupFractionalProtocol(t *testing.T) {
	res := CheckHerdrStartup(float64(Protocol)+0.7, MinHerdrVersion)
	if res.Ok {
		t.Fatal("a fractional protocol must not pass the pinned gate")
	}
	want := fmt.Sprintf("connected=%s", fmt.Sprintf("%.1f", float64(Protocol)+0.7))
	if !strings.Contains(res.Error, want) {
		t.Fatalf("error %q missing %q", res.Error, want)
	}
}

func TestCheckHerdrStartupNonNumberProtocol(t *testing.T) {
	cases := []struct {
		name     string
		protocol any
		want     string
	}{
		{name: "missing", protocol: nil, want: "connected=null"},
		{name: "string", protocol: "19", want: "connected=19"},
		{name: "nan", protocol: math.NaN(), want: "connected=NaN"},
		{name: "inf", protocol: math.Inf(1), want: "connected=+Inf"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := CheckHerdrStartup(tc.protocol, MinHerdrVersion)
			if res.Ok {
				t.Fatal("expected a non-number protocol to fail")
			}
			if !strings.Contains(res.Error, "did not return a protocol number") {
				t.Fatalf("error %q should name the protocol check", res.Error)
			}
			if !strings.Contains(res.Error, tc.want) {
				t.Fatalf("error %q missing %q", res.Error, tc.want)
			}
		})
	}
}

func TestCheckHerdrStartupVersionTooOld(t *testing.T) {
	res := CheckHerdrStartup(float64(Protocol), "0.7.4")
	if res.Ok {
		t.Fatal("expected version-too-old to fail")
	}
	for _, want := range []string{
		"herdr version too old",
		"installed=0.7.4",
		"required≥" + MinHerdrVersion,
		"connected=" + fmt.Sprint(Protocol),
		"pinned=" + fmt.Sprint(Protocol),
	} {
		if !strings.Contains(res.Error, want) {
			t.Errorf("error %q missing %q", res.Error, want)
		}
	}
}

func TestCheckHerdrStartupNonSemverVersion(t *testing.T) {
	for _, version := range []any{nil, "not-semver", 8} {
		res := CheckHerdrStartup(float64(Protocol), version)
		if res.Ok {
			t.Fatalf("expected version %v to fail", version)
		}
		if !strings.Contains(res.Error, "did not return a semver version") {
			t.Fatalf("error %q should name the semver check", res.Error)
		}
	}
}

func TestCheckHerdrStartupMatching(t *testing.T) {
	res := CheckHerdrStartup(float64(Protocol), MinHerdrVersion)
	if !res.Ok {
		t.Fatalf("expected match to pass, got %q", res.Error)
	}
	if res.Protocol != Protocol || res.Version != MinHerdrVersion {
		t.Fatalf("got protocol=%d version=%q", res.Protocol, res.Version)
	}
	if !CheckHerdrStartup(float64(Protocol), "0.9.0").Ok {
		t.Fatal("expected 0.9.0 to pass")
	}
	if CheckHerdrStartup(float64(Protocol), "0.8.0").Ok {
		t.Fatal("expected 0.8.0 to fail")
	}
}
