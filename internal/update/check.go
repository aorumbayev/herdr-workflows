package update

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/caps"
)

const (
	releaseRepo      = "aorumbayev/herdr-workflows"
	latestReleaseURL = "https://api.github.com/repos/" + releaseRepo + "/releases/latest"
	defaultTimeout   = 8 * time.Second
)

type CheckOpts struct {
	Timeout time.Duration
	URL     string
	Client  *http.Client
}

func CheckForUpdate(opts CheckOpts) (LatestRelease, error) {
	timeout := opts.Timeout
	if timeout == 0 {
		timeout = defaultTimeout
	}
	url := opts.URL
	if url == "" {
		url = latestReleaseURL
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return LatestRelease{}, releaseErr("latest release request failed: " + err.Error())
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "herdr-workflows")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	client := opts.Client
	if client == nil {
		client = http.DefaultClient
	}
	res, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return LatestRelease{}, releaseErr(fmt.Sprintf("latest release request timed out after %dms", timeout.Milliseconds()))
		}
		return LatestRelease{}, releaseErr("latest release request failed: " + err.Error())
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return LatestRelease{}, releaseErr(fmt.Sprintf("latest release request failed: HTTP %d", res.StatusCode))
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, int64(caps.CaptureByteLimit)+1))
	if err != nil {
		return LatestRelease{}, releaseErr("latest release request failed: " + err.Error())
	}
	if len(body) > caps.CaptureByteLimit {
		return LatestRelease{}, &caps.CaptureLimitError{Source: "latest release body", Bytes: len(body), Limit: caps.CaptureByteLimit}
	}
	var parsed struct {
		TagName string `json:"tag_name"`
		Draft   bool   `json:"draft"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return LatestRelease{}, releaseErr("latest release response missing tag_name")
	}
	if parsed.Draft {
		return LatestRelease{}, releaseErr("latest release endpoint returned a draft")
	}
	if parsed.TagName == "" {
		return LatestRelease{}, releaseErr("latest release response missing tag_name")
	}
	return ParseReleaseTag(parsed.TagName)
}
