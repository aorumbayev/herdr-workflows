package workbench

// AppendRouteHash appends a route hash to an authenticated base URL.
func AppendRouteHash(url string, route *WebRoute) string {
	if route == nil {
		return url
	}
	return url + "#" + route.Hash
}
