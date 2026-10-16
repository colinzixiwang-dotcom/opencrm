package main

import (
	"context"
	"fmt"
	"harbor/internal/httpapi"
	"harbor/internal/integrations/udesk"
	"harbor/internal/store"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	if e := udesk.LoadEnv(".env"); e != nil {
		log.Fatal("Cannot load backend configuration: ", e)
	}
	dist := os.Getenv("DIST_DIR")
	if dist == "" {
		dist = "frontend/dist"
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "4317"
	}
	db, e := store.Open(os.Getenv("PG_TEST_NAMESPACE"))
	if e != nil {
		log.Fatal(e)
	}
	defer db.Close()
	s := &http.Server{Addr: "127.0.0.1:" + port, Handler: httpapi.New(db, dist).Router(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		fmt.Printf("Harbor ERP · React + Go/Gin · RuoYi RBAC\nhttp://127.0.0.1:%s\n", port)
		if e := s.ListenAndServe(); e != nil && e != http.ErrServerClosed {
			log.Fatal(e)
		}
	}()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s.Shutdown(ctx)
}
