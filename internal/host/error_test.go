package host

import (
	"errors"
	"testing"
)

func TestIsTransportLoss(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{
			name: "transport loss code closed",
			err:  &HerdrError{Code: "closed", Msg: "pane.split: socket closed"},
			want: true,
		},
		{
			name: "transport loss code no_socket",
			err:  &HerdrError{Code: "no_socket", Msg: "HERDR_SOCKET_PATH is not set"},
			want: true,
		},
		{
			name: "transport loss code unreachable",
			err:  &HerdrError{Code: "unreachable", Msg: "unreachable herdr at /tmp/x: pane.split: closed"},
			want: true,
		},
		{
			name: "non-transport HerdrError",
			err:  &HerdrError{Code: "invalid_params", Msg: "bad ratio"},
			want: false,
		},
		{
			name: "generic error",
			err:  &HerdrError{Code: "internal", Msg: "plain Error wrapped"},
			want: false,
		},
		{
			name: "non-error type",
			err:  nil,
			want: false,
		},
		{
			name: "plain error read ECONNRESET",
			err:  errors.New("read ECONNRESET"),
			want: false,
		},
		{
			name: "plain error write EPIPE",
			err:  errors.New("write EPIPE"),
			want: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := IsTransportLoss(tc.err)
			if got != tc.want {
				t.Fatalf("IsTransportLoss(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}
