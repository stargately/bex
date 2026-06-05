// The "agent": answers 200 OK on every GET. MESSAGE is overridable so a redeploy
// can visibly change the response; PORT is injected by the platform.
package main

import (
	"fmt"
	"net/http"
	"os"
)

func main() {
	msg := os.Getenv("MESSAGE")
	if msg == "" {
		msg = "OK"
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	http.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, msg)
	})
	fmt.Printf("hello-go listening on %s: %q\n", port, msg)
	_ = http.ListenAndServe(":"+port, nil)
}
