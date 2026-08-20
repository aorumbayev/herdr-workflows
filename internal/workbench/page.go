package workbench

import (
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"sync"

	assets "github.com/aorumbayev/herdr-workflows/embed"
	"github.com/evanw/esbuild/pkg/api"
)

var (
	pageOnce     sync.Once
	pageTemplate string
	pageInitErr  error
	exportPrefix = regexp.MustCompile(`(?m)^export `)
)

func initPageTemplate() {
	result := api.Transform(assets.FieldModelTS, api.TransformOptions{
		Loader: api.LoaderTS,
	})
	if len(result.Errors) > 0 {
		pageInitErr = fmt.Errorf("field model transform: %s", result.Errors[0].Text)
		return
	}
	js := exportPrefix.ReplaceAllString(string(result.Code), "")
	page := strings.Replace(assets.PageHTML, "/* __HWF_FIELD_MODEL__ */", js, 1)
	if !strings.Contains(page, "function addressesField") {
		pageInitErr = fmt.Errorf("field model failed to inline into the workbench page")
		return
	}
	pageTemplate = page
}

func preparedPage() (string, error) {
	pageOnce.Do(initPageTemplate)
	return pageTemplate, pageInitErr
}

func (s *Server) handleFavicon(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "image/svg+xml")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_, _ = w.Write([]byte(assets.LogoSVG))
}

func (s *Server) handlePage(w http.ResponseWriter, _ *http.Request) {
	page, err := preparedPage()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	html := strings.Replace(page, "__HWF_TOKEN__", s.Token, 1)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte(html))
}
