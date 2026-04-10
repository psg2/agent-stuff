package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

// ANSI colors
const (
	red    = "\033[0;31m"
	green  = "\033[0;32m"
	yellow = "\033[0;33m"
	cyan   = "\033[0;36m"
	bold   = "\033[1m"
	dim    = "\033[2m"
	reset  = "\033[0m"
)

// Profile is the saved profile on disk (metadata only, no secrets).
// Each profile maps to its own CLAUDE_CONFIG_DIR, which gives it an
// isolated Keychain entry (macOS) or credentials file (Linux/Windows).
type Profile struct {
	Name             string          `json:"name"`
	SavedAt          string          `json:"savedAt"`
	Email            string          `json:"email"`
	Org              string          `json:"org"`
	SubscriptionType string          `json:"subscriptionType"`
	OAuthAccount     json.RawMessage `json:"oauthAccount"`
}

// OAuthAccount is the subset we need to read from ~/.claude.json.
type OAuthAccount struct {
	AccountUUID      string `json:"accountUuid"`
	EmailAddress     string `json:"emailAddress"`
	OrganizationName string `json:"organizationName"`
}

// CredentialsOAuth is the subset we need from keychain/credentials.
type CredentialsOAuth struct {
	SubscriptionType string `json:"subscriptionType"`
}

// Credentials wraps the keychain JSON.
type Credentials struct {
	ClaudeAiOauth CredentialsOAuth `json:"claudeAiOauth"`
}

func die(msg string) {
	fmt.Fprintf(os.Stderr, "%serror:%s %s\n", red, reset, msg)
	os.Exit(1)
}

func profilesDir() string {
	return filepath.Join(os.Getenv("HOME"), ".config", "claude-switch", "profiles")
}

func profileConfigDir(name string) string {
	return filepath.Join(os.Getenv("HOME"), ".claude-"+name)
}

func claudeJSONPath() string {
	return filepath.Join(os.Getenv("HOME"), ".claude.json")
}

func ensureProfilesDir() {
	if err := os.MkdirAll(profilesDir(), 0755); err != nil {
		die(fmt.Sprintf("Cannot create profiles directory: %v", err))
	}
}

// shellQuote wraps a string in single quotes, escaping embedded single quotes.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'"
}

// ── Credential storage (platform-specific) ──────────────────────────────────

func readCredentials() json.RawMessage {
	data, err := readCredentialsFromStore()
	if err != nil {
		die(fmt.Sprintf("Cannot read Claude Code credentials: %v", err))
	}
	return data
}

func writeCredentials(data json.RawMessage) {
	if err := writeCredentialsToStore(data); err != nil {
		die(fmt.Sprintf("Cannot write Claude Code credentials: %v", err))
	}
}

// ── claude.json helpers ─────────────────────────────────────────────────────

func readClaudeJSON() map[string]json.RawMessage {
	data, err := os.ReadFile(claudeJSONPath())
	if err != nil {
		die(fmt.Sprintf("Cannot read %s: %v", claudeJSONPath(), err))
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(data, &m); err != nil {
		die(fmt.Sprintf("Cannot parse %s: %v", claudeJSONPath(), err))
	}
	return m
}

func readOAuthAccount() (json.RawMessage, OAuthAccount) {
	m := readClaudeJSON()
	raw, ok := m["oauthAccount"]
	if !ok {
		die("No oauthAccount found in " + claudeJSONPath())
	}
	var acct OAuthAccount
	json.Unmarshal(raw, &acct)
	return raw, acct
}

func writeOAuthAccount(account json.RawMessage) {
	m := readClaudeJSON()
	m["oauthAccount"] = account

	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		die(fmt.Sprintf("Cannot serialize claude.json: %v", err))
	}

	tmp := claudeJSONPath() + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0644); err != nil {
		die(fmt.Sprintf("Cannot write %s: %v", tmp, err))
	}
	if err := os.Rename(tmp, claudeJSONPath()); err != nil {
		os.Remove(tmp)
		die(fmt.Sprintf("Cannot update %s: %v", claudeJSONPath(), err))
	}
}

// ── Profile I/O ─────────────────────────────────────────────────────────────

func loadProfile(name string) Profile {
	path := filepath.Join(profilesDir(), name+".json")
	data, err := os.ReadFile(path)
	if err != nil {
		die(fmt.Sprintf("Profile '%s' not found. Run 'claude-switch list' to see available profiles.", name))
	}
	var p Profile
	if err := json.Unmarshal(data, &p); err != nil {
		die(fmt.Sprintf("Cannot parse profile '%s': %v", name, err))
	}
	return p
}

func saveProfile(p Profile) {
	data, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		die(fmt.Sprintf("Cannot serialize profile: %v", err))
	}
	path := filepath.Join(profilesDir(), p.Name+".json")
	if err := os.WriteFile(path, append(data, '\n'), 0600); err != nil {
		die(fmt.Sprintf("Cannot write profile: %v", err))
	}
}

func listProfiles() []Profile {
	entries, err := os.ReadDir(profilesDir())
	if err != nil {
		return nil
	}
	var profiles []Profile
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		name := strings.TrimSuffix(e.Name(), ".json")
		profiles = append(profiles, loadProfile(name))
	}
	sort.Slice(profiles, func(i, j int) bool {
		return profiles[i].Name < profiles[j].Name
	})
	return profiles
}

func currentAccountUUID() string {
	_, acct := readOAuthAccount()
	return acct.AccountUUID
}

func profileAccountUUID(p Profile) string {
	var acct OAuthAccount
	json.Unmarshal(p.OAuthAccount, &acct)
	return acct.AccountUUID
}

// ── Commands ────────────────────────────────────────────────────────────────

func cmdRun(name string, claudeArgs []string) {
	_ = loadProfile(name) // verify profile exists

	configDir := profileConfigDir(name)
	if err := os.MkdirAll(configDir, 0755); err != nil {
		die(fmt.Sprintf("Cannot create config directory: %v", err))
	}

	claudePath, err := exec.LookPath("claude")
	if err != nil {
		die("Cannot find 'claude' in PATH. Is Claude Code installed?")
	}

	// Inherit current env + set CLAUDE_CONFIG_DIR
	env := os.Environ()
	env = append(env, "CLAUDE_CONFIG_DIR="+configDir)

	cmd := exec.Command(claudePath, claudeArgs...)
	cmd.Env = env
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Run(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			os.Exit(exitErr.ExitCode())
		}
		die(fmt.Sprintf("Failed to run claude: %v", err))
	}
}

func cmdEnv(name string) {
	_ = loadProfile(name) // verify profile exists
	fmt.Printf("export CLAUDE_CONFIG_DIR=%s\n", shellQuote(profileConfigDir(name)))
}

func cmdInit() {
	fmt.Print(`# claude-switch shell integration
# Add to ~/.zshrc or ~/.bashrc:  eval "$(claude-switch init)"
claude() {
  local _profile="" _yolo=""
  local _args=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -a) _profile="$2"; shift 2 ;;
      --yolo) _yolo="--dangerously-skip-permissions"; shift ;;
      *) _args+=("$1"); shift ;;
    esac
  done
  if [[ -n "$_profile" ]]; then
    command claude-switch run "$_profile" -- $_yolo "${_args[@]}"
  else
    command claude $_yolo "${_args[@]}"
  fi
}
`)
}

func cmdSave(name string) {
	ensureProfilesDir()

	rawOAuth, acct := readOAuthAccount()
	creds := readCredentials()

	// Save credentials to platform credential store (for legacy 'use' command)
	if err := saveProfileCredentials(name, creds); err != nil {
		die(fmt.Sprintf("Cannot save credentials for profile '%s': %v", name, err))
	}

	var c Credentials
	json.Unmarshal(creds, &c)

	// Save metadata (no secrets) to disk
	p := Profile{
		Name:             name,
		SavedAt:          time.Now().UTC().Format(time.RFC3339),
		Email:            acct.EmailAddress,
		Org:              acct.OrganizationName,
		SubscriptionType: c.ClaudeAiOauth.SubscriptionType,
		OAuthAccount:     rawOAuth,
	}
	saveProfile(p)

	// Create profile config dir for the run/env workflow
	configDir := profileConfigDir(name)
	os.MkdirAll(configDir, 0755)

	fmt.Printf("%sSaved profile '%s'%s (%s, %s)\n", green, name, reset, acct.EmailAddress, c.ClaudeAiOauth.SubscriptionType)
	fmt.Printf("%sConfig dir: %s%s\n", dim, configDir, reset)
	fmt.Printf("%sRun '%sclaude-switch run %s%s' and /login to authenticate this profile.%s\n", yellow, cyan, name, yellow, reset)
}

func cmdUse(name string) {
	p := loadProfile(name)

	// Load credentials from platform credential store
	creds, err := loadProfileCredentials(name)
	if err != nil {
		die(fmt.Sprintf("Cannot load credentials for profile '%s': %v", name, err))
	}

	writeCredentials(creds)
	writeOAuthAccount(p.OAuthAccount)
	fmt.Printf("%sSwitched to '%s'%s (%s, %s)\n", green, name, reset, p.Email, p.SubscriptionType)
	fmt.Printf("%sRestart Claude Code for changes to take effect.%s\n", yellow, reset)
}

func cmdList() {
	ensureProfilesDir()
	profiles := listProfiles()
	if len(profiles) == 0 {
		fmt.Printf("%sNo profiles saved yet. Run 'claude-switch save <name>' to save the current session.%s\n", dim, reset)
		return
	}

	currentUUID := currentAccountUUID()
	for _, p := range profiles {
		uuid := profileAccountUUID(p)
		marker := "  "
		nameColor := ""
		nameReset := ""
		subColor := dim
		if uuid == currentUUID {
			marker = fmt.Sprintf("%s%s->%s", green, bold, reset)
			nameColor = fmt.Sprintf("%s%s", green, bold)
			nameReset = reset
			subColor = green
		}
		fmt.Printf("  %s %s%s%s  %s%s%s  %s%s%s\n",
			marker, nameColor, p.Name, nameReset,
			dim, p.Email, reset,
			subColor, p.SubscriptionType, reset)
	}
}

func cmdCurrent() {
	ensureProfilesDir()
	currentUUID := currentAccountUUID()
	for _, p := range listProfiles() {
		if profileAccountUUID(p) == currentUUID {
			fmt.Printf("%s%s%s  %s%s%s  %s\n", green, p.Name, reset, dim, p.Email, reset, p.SubscriptionType)
			return
		}
	}
	fmt.Printf("%sCurrent session does not match any saved profile.%s\n", yellow, reset)
	os.Exit(1)
}

func cmdRemove(name string) {
	path := filepath.Join(profilesDir(), name+".json")
	if _, err := os.Stat(path); os.IsNotExist(err) {
		die(fmt.Sprintf("Profile '%s' not found.", name))
	}
	if err := os.Remove(path); err != nil {
		die(fmt.Sprintf("Cannot remove profile: %v", err))
	}
	// Clean up credentials from platform store (best effort)
	deleteProfileCredentials(name)
	fmt.Printf("%sRemoved profile '%s'%s\n", green, name, reset)

	configDir := profileConfigDir(name)
	if _, err := os.Stat(configDir); err == nil {
		fmt.Printf("%sNote: config dir %s was not removed. Delete it manually if desired.%s\n", dim, configDir, reset)
	}
}

func usage() {
	fmt.Printf("%sclaude-switch%s — manage multiple Claude Code profiles\n", bold, reset)
	fmt.Println()
	fmt.Printf("%sUSAGE%s\n", bold, reset)
	fmt.Println("  claude-switch <command> [args]")
	fmt.Println()
	fmt.Printf("%sCOMMANDS%s\n", bold, reset)
	fmt.Println("  save <name>           Save current session as a named profile")
	fmt.Println("  run <name> [-- args]  Launch claude with a profile's config dir")
	fmt.Println("  env <name>            Print CLAUDE_CONFIG_DIR export (for scripting)")
	fmt.Println("  init                  Print shell integration (for ~/.zshrc)")
	fmt.Println("  list                  Show all profiles (arrow marks active)")
	fmt.Println("  current               Show the active profile")
	fmt.Println("  remove <name>         Delete a saved profile")
	fmt.Println("  use <name>            Legacy: swap default credentials")
	fmt.Println()
	fmt.Printf("%sHOW IT WORKS%s\n", bold, reset)
	fmt.Println("  Each profile gets its own CLAUDE_CONFIG_DIR (~/.claude-<name>).")
	fmt.Println("  Claude Code automatically uses a distinct Keychain entry per config dir,")
	fmt.Println("  so profiles are fully isolated — no credential conflicts.")
	fmt.Println()
	fmt.Printf("%sPLATFORM%s\n", bold, reset)
	fmt.Printf("  %s/%s\n", runtime.GOOS, runtime.GOARCH)
	fmt.Println()
	fmt.Printf("%sEXAMPLES%s\n", bold, reset)
	fmt.Println()
	fmt.Printf("  %sSetup:%s\n", dim, reset)
	fmt.Println("  claude-switch save personal          # save current account")
	fmt.Println("  claude-switch run personal            # login in profile config dir")
	fmt.Println("  claude /login                         # log into another account")
	fmt.Println("  claude-switch save work")
	fmt.Println("  claude-switch run work")
	fmt.Println()
	fmt.Printf("  %sDaily use:%s\n", dim, reset)
	fmt.Println("  claude-switch run work")
	fmt.Println("  claude-switch run personal -- -p 'summarize this repo'")
	fmt.Println()
	fmt.Printf("  %sShell integration (recommended):%s\n", dim, reset)
	fmt.Printf("  eval \"$(claude-switch init)\"   %s# add to ~/.zshrc%s\n", dim, reset)
	fmt.Println("  claude -a work                  # launch with work profile")
	fmt.Println("  claude -a personal              # concurrent in another terminal")
}

func main() {
	if len(os.Args) < 2 {
		usage()
		return
	}

	cmd := os.Args[1]
	arg := ""
	if len(os.Args) > 2 {
		arg = os.Args[2]
	}

	switch cmd {
	case "save":
		if arg == "" {
			die("Usage: claude-switch save <name>")
		}
		cmdSave(arg)
	case "run":
		if arg == "" {
			die("Usage: claude-switch run <name> [-- claude-args...]")
		}
		claudeArgs := os.Args[3:]
		if len(claudeArgs) > 0 && claudeArgs[0] == "--" {
			claudeArgs = claudeArgs[1:]
		}
		cmdRun(arg, claudeArgs)
	case "use":
		if arg == "" {
			die("Usage: claude-switch use <name>")
		}
		cmdUse(arg)
	case "env":
		if arg == "" {
			die("Usage: claude-switch env <name>")
		}
		cmdEnv(arg)
	case "init":
		cmdInit()
	case "list", "ls":
		cmdList()
	case "current":
		cmdCurrent()
	case "remove", "rm":
		if arg == "" {
			die("Usage: claude-switch remove <name>")
		}
		cmdRemove(arg)
	case "-h", "--help", "help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "%sunknown command:%s %s\n", red, reset, cmd)
		fmt.Fprintln(os.Stderr)
		usage()
		os.Exit(1)
	}
}
