//go:build !darwin

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

func credentialsFilePath() string {
	dir := os.Getenv("CLAUDE_CONFIG_DIR")
	if dir == "" {
		dir = filepath.Join(os.Getenv("HOME"), ".claude")
	}
	return filepath.Join(dir, ".credentials.json")
}

func profileCredentialsPath(name string) string {
	return filepath.Join(os.Getenv("HOME"), ".config", "claude-switch", "credentials", name+".json")
}

func readJSONFile(path string) (json.RawMessage, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("invalid JSON in %s: %v", path, err)
	}
	return json.RawMessage(data), nil
}

func writeJSONFile(path string, data json.RawMessage) error {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(data, &m); err != nil {
		return err
	}
	pretty, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	return os.WriteFile(path, append(pretty, '\n'), 0600)
}

// Active credentials (what Claude Code reads)

func readCredentialsFromStore() (json.RawMessage, error) {
	data, err := readJSONFile(credentialsFilePath())
	if err != nil {
		return nil, fmt.Errorf("cannot read credentials (are you logged in?): %v", err)
	}
	return data, nil
}

func writeCredentialsToStore(data json.RawMessage) error {
	return writeJSONFile(credentialsFilePath(), data)
}

// Per-profile credentials

func saveProfileCredentials(name string, data json.RawMessage) error {
	return writeJSONFile(profileCredentialsPath(name), data)
}

func loadProfileCredentials(name string) (json.RawMessage, error) {
	data, err := readJSONFile(profileCredentialsPath(name))
	if err != nil {
		return nil, fmt.Errorf("credentials for profile '%s' not found", name)
	}
	return data, nil
}

func deleteProfileCredentials(name string) error {
	path := profileCredentialsPath(name)
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}
