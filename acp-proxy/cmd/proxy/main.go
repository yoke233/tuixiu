package main

import (
	"flag"
	"log"

	"acp-proxy/internal/config"
	"acp-proxy/internal/proxy"
)

func main() {
	configPath := flag.String("config", "config.json", "Path to config JSON file")
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	p := proxy.New(cfg)
	if err := p.Run(); err != nil {
		log.Fatalf("proxy exited: %v", err)
	}
}

