package main

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
)

const keychainService = "Claude Code-credentials"

func profileKeychainService(name string) string {
	return keychainService + "." + name
}

func readKeychainEntry(service string) (json.RawMessage, error) {
	out, err := exec.Command("security", "find-generic-password", "-s", service, "-w").Output()
	if err != nil {
		return nil, fmt.Errorf("no entry for '%s' in Keychain", service)
	}
	raw := json.RawMessage(strings.TrimSpace(string(out)))
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("invalid JSON in Keychain entry '%s': %v", service, err)
	}
	return raw, nil
}

func writeKeychainEntry(service string, data json.RawMessage) error {
	compact, err := json.Marshal(json.RawMessage(data))
	if err != nil {
		return fmt.Errorf("cannot compact credentials: %v", err)
	}
	cmd := exec.Command("security", "add-generic-password", "-U",
		"-s", service,
		"-a", service,
		"-w", string(compact),
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("keychain write failed: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

func deleteKeychainEntry(service string) error {
	cmd := exec.Command("security", "delete-generic-password", "-s", service)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("keychain delete failed: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

// Active credentials (what Claude Code reads)

func readCredentialsFromStore() (json.RawMessage, error) {
	return readKeychainEntry(keychainService)
}

func writeCredentialsToStore(data json.RawMessage) error {
	return writeKeychainEntry(keychainService, data)
}

// Per-profile credentials

func saveProfileCredentials(name string, data json.RawMessage) error {
	return writeKeychainEntry(profileKeychainService(name), data)
}

func loadProfileCredentials(name string) (json.RawMessage, error) {
	return readKeychainEntry(profileKeychainService(name))
}

func deleteProfileCredentials(name string) error {
	return deleteKeychainEntry(profileKeychainService(name))
}
