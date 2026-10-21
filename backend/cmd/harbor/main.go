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
	host := os.Getenv("HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	db, e := store.Open(os.Getenv("PG_TEST_NAMESPACE"))
	if e != nil {
		log.Fatal(e)
	}
	defer db.Close()
	app := httpapi.New(db, dist)
	background, stopBackground := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		if app.Tickets.API != nil && udesk.FromEnv().Configured() {
			app.Tickets.Run(background)
		}
	}()
	s := &http.Server{Addr: host + ":" + port, Handler: app.Router(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		fmt.Printf("Harbor ERP · React + Go/Gin · RuoYi RBAC\nhttp://%s:%s\n", host, port)
		if e := s.ListenAndServe(); e != nil && e != http.ErrServerClosed {
			log.Fatal(e)
		}
	}()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	stopBackground()
	s.Shutdown(ctx)
	select {
	case <-done:
	case <-ctx.Done():
	}
}
