package workbench

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const defaultPort = 7317

// Server is a loopback workbench HTTP listener.
type Server struct {
	URL      string
	Token    string
	repoRoot string
	port     int
	http     *http.Server
	ln       net.Listener
}

// Options start a workbench server for one checkout.
type Options struct {
	RepoRoot string
	Port     int
}

// StartWebServer binds 127.0.0.1 and serves the authenticated workbench.
func StartWebServer(opts Options) (*Server, error) {
	if opts.RepoRoot == "" {
		return nil, errors.New("workbench: repo root is required")
	}
	token, err := newToken()
	if err != nil {
		return nil, err
	}
	port := opts.Port
	if port == 0 {
		port = defaultPort
	}
	var ln net.Listener
	for {
		ln, err = net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
		if err == nil {
			break
		}
		if opts.Port == 0 && isAddrInUse(err) {
			port++
			continue
		}
		return nil, err
	}
	return serveListener(opts.RepoRoot, token, ln), nil
}

func serveListener(repoRoot, token string, ln net.Listener) *Server {
	port := ln.Addr().(*net.TCPAddr).Port
	s := &Server{
		URL:      originOf(port) + "/?token=" + token,
		Token:    token,
		repoRoot: repoRoot,
		port:     port,
		ln:       ln,
	}
	s.http = &http.Server{Handler: s, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = s.http.Serve(ln) }()
	return s
}

// Stop closes the listener.
func (s *Server) Stop() {
	if s == nil || s.http == nil {
		return
	}
	_ = s.http.Close()
}

func originOf(port int) string {
	return "http://127.0.0.1:" + strconv.Itoa(port)
}

func newToken() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	dst := make([]byte, 36)
	hex.Encode(dst[0:8], b[0:4])
	dst[8] = '-'
	hex.Encode(dst[9:13], b[4:6])
	dst[13] = '-'
	hex.Encode(dst[14:18], b[6:8])
	dst[18] = '-'
	hex.Encode(dst[19:23], b[8:10])
	dst[23] = '-'
	hex.Encode(dst[24:36], b[10:16])
	return string(dst), nil
}

func isAddrInUse(err error) bool {
	return strings.Contains(strings.ToLower(err.Error()), "address already in use")
}

func hostAllowed(value string, port int) bool {
	if value == "" {
		return false
	}
	host := strings.TrimPrefix(strings.TrimPrefix(value, "https://"), "http://")
	want := strconv.Itoa(port)
	return host == "127.0.0.1:"+want || host == "localhost:"+want || host == "127.0.0.1" || host == "localhost"
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(body)
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !hostAllowed(r.Host, s.port) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" && !hostAllowed(origin, s.port) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	switch r.URL.Path {
	case "/favicon.svg", "/favicon.ico":
		s.handleFavicon(w, r)
		return
	case "/":
		if r.URL.Query().Get("token") != s.Token {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		s.handlePage(w, r)
		return
	}

	if !strings.HasPrefix(r.URL.Path, "/api/") {
		http.NotFound(w, r)
		return
	}
	if r.Header.Get("X-Hwf-Token") != s.Token {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	switch r.URL.Path {
	case "/api/state":
		s.handleState(w, r)
	case "/api/schema":
		s.handleSchema(w, r)
	case "/api/methods":
		s.handleMethods(w, r)
	case "/api/workflow":
		s.handleWorkflow(w, r)
	case "/api/parse":
		s.handleParse(w, r)
	case "/api/format":
		s.handleFormat(w, r)
	case "/api/validate":
		s.handleValidate(w, r)
	case "/api/config":
		s.handleConfig(w, r)
	case "/api/runs":
		s.handleRuns(w, r)
	case "/api/run":
		s.handleRunDetail(w, r)
	case "/api/share":
		s.handleShare(w, r)
	case "/api/import/preview":
		s.handleImportPreview(w, r)
	case "/api/import":
		s.handleImportWrite(w, r)
	default:
		http.NotFound(w, r)
	}
}
