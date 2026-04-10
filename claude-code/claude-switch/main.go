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

// Default OAuth scopes for Claude Code
const defaultOAuthScopes = "user:profile user:inference user:sessions:claude_code"

// Profile is the saved profile on disk (metadata only, no secrets).
// Credentials are stored in the platform credential store (Keychain on macOS,
// file with 0600 permissions on Linux/Windows).
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

func tokenDir() string {
	return filepath.Join(os.Getenv("HOME"), ".config", "claude-switch", "tokens")
}

func tokenFilePath(name string) string {
	return filepath.Join(tokenDir(), name)
}

func profileConfigDir(name string) string {
	return filepath.Join(os.Getenv("HOME"), ".claude-profiles", name)
}

func claudeJSONPath() string {
	return filepath.Join(os.Getenv("HOME"), ".claude.json")
}

func ensureProfilesDir() {
	if err := os.MkdirAll(profilesDir(), 0755); err != nil {
		die(fmt.Sprintf("Cannot create profiles directory: %v", err))
	}
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

// ── Token helpers ──────────────────────────────────────────────────────────

// extractedTokens holds OAuth tokens parsed from stored credentials.
type extractedTokens struct {
	accessToken  string
	refreshToken string
	scopes       string
}

// extractTokens tries to find OAuth tokens in the credentials JSON.
// Claude Code stores credentials as {"claudeAiOauth": {...}}.
func extractTokens(creds json.RawMessage) extractedTokens {
	var t extractedTokens

	var credMap map[string]json.RawMessage
	if err := json.Unmarshal(creds, &credMap); err != nil {
		return t
	}

	oauthRaw, ok := credMap["claudeAiOauth"]
	if !ok {
		return t
	}

	var oauthMap map[string]interface{}
	if err := json.Unmarshal(oauthRaw, &oauthMap); err != nil {
		return t
	}

	findStr := func(keys ...string) string {
		for _, k := range keys {
			if v, ok := oauthMap[k]; ok {
				if s, ok := v.(string); ok && s != "" {
					return s
				}
			}
		}
		return ""
	}

	t.accessToken = findStr("accessToken", "access_token", "token")
	t.refreshToken = findStr("refreshToken", "refresh_token")
	t.scopes = findStr("scopes", "scope")
	return t
}

// shellQuote wraps a string in single quotes, escaping embedded single quotes.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'"
}

// ── Env resolution ─────────────────────────────────────────────────────────

type envPair struct {
	key, value string
}

// resolveProfileEnv returns the env vars needed to run Claude with a profile.
// Returns nil if no tokens can be resolved.
func resolveProfileEnv(name string) []envPair {
	_ = loadProfile(name) // verify profile exists

	var pairs []envPair

	// 1. Check for manually-set token (highest priority)
	if data, err := os.ReadFile(tokenFilePath(name)); err == nil {
		token := strings.TrimSpace(string(data))
		if token != "" {
			pairs = append(pairs, envPair{"CLAUDE_CODE_OAUTH_TOKEN", token})
		}
	}

	// 2. Try extracting tokens from stored credentials
	if len(pairs) == 0 {
		creds, err := loadProfileCredentials(name)
		if err == nil {
			tokens := extractTokens(creds)

			if tokens.refreshToken != "" {
				pairs = append(pairs, envPair{"CLAUDE_CODE_OAUTH_REFRESH_TOKEN", tokens.refreshToken})
				scopes := tokens.scopes
				if scopes == "" {
					scopes = defaultOAuthScopes
				}
				pairs = append(pairs, envPair{"CLAUDE_CODE_OAUTH_SCOPES", scopes})
			}

			if tokens.accessToken != "" {
				pairs = append(pairs, envPair{"CLAUDE_CODE_OAUTH_TOKEN", tokens.accessToken})
			}
		}
	}

	if len(pairs) == 0 {
		return nil
	}

	// Add config dir for full session isolation
	pairs = append(pairs, envPair{"CLAUDE_CONFIG_DIR", profileConfigDir(name)})
	return pairs
}

func dieNoToken(name string) {
	fmt.Fprintf(os.Stderr, "%serror:%s No OAuth token found for profile '%s'.\n", red, reset, name)
	fmt.Fprintf(os.Stderr, "\nTo set one:\n")
	fmt.Fprintf(os.Stderr, "  1. Switch to the profile:  %sclaude-switch use %s%s\n", cyan, name, reset)
	fmt.Fprintf(os.Stderr, "  2. Generate a token:       %sclaude setup-token%s\n", cyan, reset)
	fmt.Fprintf(os.Stderr, "  3. Save the token:         %sclaude-switch token %s <token>%s\n", cyan, name, reset)
	os.Exit(1)
}

// ── Commands ────────────────────────────────────────────────────────────────

func cmdRun(name string, claudeArgs []string) {
	pairs := resolveProfileEnv(name)
	if pairs == nil {
		dieNoToken(name)
	}

	claudePath, err := exec.LookPath("claude")
	if err != nil {
		die("Cannot find 'claude' in PATH. Is Claude Code installed?")
	}

	// Inherit current env + add profile overrides
	env := os.Environ()
	for _, p := range pairs {
		env = append(env, p.key+"="+p.value)
	}

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
	pairs := resolveProfileEnv(name)
	if pairs == nil {
		dieNoToken(name)
	}
	for _, p := range pairs {
		fmt.Printf("export %s=%s\n", p.key, shellQuote(p.value))
	}
}

func cmdInit() {
	fmt.Print(`# claude-switch shell integration
# Add to ~/.zshrc or ~/.bashrc:  eval "$(claude-switch init)"
claude() {
  if [[ "$1" == "-a" ]] && [[ -n "$2" ]]; then
    local _profile="$2"
    shift 2
    command claude-switch run "$_profile" -- "$@"
    return $?
  fi
  command claude "$@"
}
`)
}

func cmdToken(name string, args []string) {
	_ = loadProfile(name) // verify profile exists

	if len(args) == 0 {
		// Show current token (masked)
		if data, err := os.ReadFile(tokenFilePath(name)); err == nil {
			t := strings.TrimSpace(string(data))
			if len(t) > 16 {
				fmt.Printf("%s...%s\n", t[:8], t[len(t)-4:])
			} else if t != "" {
				fmt.Println("(set)")
			} else {
				fmt.Printf("%sNo token set for profile '%s'%s\n", yellow, name, reset)
			}
		} else {
			fmt.Printf("%sNo token set for profile '%s'%s\n", yellow, name, reset)
		}
		return
	}

	token := strings.TrimSpace(args[0])
	if token == "" {
		die("Token cannot be empty")
	}

	if err := os.MkdirAll(tokenDir(), 0700); err != nil {
		die(fmt.Sprintf("Cannot create token directory: %v", err))
	}
	if err := os.WriteFile(tokenFilePath(name), []byte(token), 0600); err != nil {
		die(fmt.Sprintf("Cannot save token: %v", err))
	}
	fmt.Printf("%sToken saved for profile '%s'%s\n", green, name, reset)
	fmt.Printf("Use it with: %sclaude-switch run %s%s\n", cyan, name, reset)
}

func cmdSave(name string) {
	ensureProfilesDir()

	rawOAuth, acct := readOAuthAccount()
	creds := readCredentials()

	// Save credentials to platform credential store
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
	fmt.Printf("%sSaved profile '%s'%s (%s, %s)\n", green, name, reset, acct.EmailAddress, c.ClaudeAiOauth.SubscriptionType)
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
		if uuid == currentUUID {
			fmt.Printf("  %s%s-> %s%s  %s%s%s  %s%s%s\n", green, bold, p.Name, reset, dim, p.Email, reset, green, p.SubscriptionType, reset)
		} else {
			fmt.Printf("     %s  %s%s%s  %s%s%s\n", p.Name, dim, p.Email, reset, dim, p.SubscriptionType, reset)
		}
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
	// Clean up manually-set token (best effort)
	os.Remove(tokenFilePath(name))
	fmt.Printf("%sRemoved profile '%s'%s\n", green, name, reset)
}

func usage() {
	fmt.Printf("%sclaude-switch%s — switch between Claude Code subscriptions\n", bold, reset)
	fmt.Println()
	fmt.Printf("%sUSAGE%s\n", bold, reset)
	fmt.Println("  claude-switch <command> [args]")
	fmt.Println()
	fmt.Printf("%sCOMMANDS%s\n", bold, reset)
	fmt.Println("  save <name>           Save current session as a named profile")
	fmt.Println("  run <name> [-- args]  Launch claude directly with a profile")
	fmt.Println("  use <name>            Switch the default profile (legacy, restarts needed)")
	fmt.Println("  env <name>            Print env vars (for scripting)")
	fmt.Println("  init                  Print shell integration (for ~/.zshrc)")
	fmt.Println("  token <name> [token]  Set or show an OAuth token for a profile")
	fmt.Println("  list                  Show all profiles (arrow marks active)")
	fmt.Println("  current               Show the active profile")
	fmt.Println("  remove <name>         Delete a saved profile")
	fmt.Println()
	fmt.Printf("%sPLATFORM%s\n", bold, reset)
	fmt.Printf("  %s/%s", runtime.GOOS, runtime.GOARCH)
	switch runtime.GOOS {
	case "darwin":
		fmt.Println(" (credentials via macOS Keychain)")
	case "linux", "windows":
		fmt.Println(" (credentials via ~/.claude/.credentials.json)")
	}
	fmt.Println()
	fmt.Printf("%sEXAMPLES%s\n", bold, reset)
	fmt.Println()
	fmt.Printf("  %sLaunch directly with a profile:%s\n", dim, reset)
	fmt.Println("  claude-switch run work")
	fmt.Println("  claude-switch run personal -- -p 'summarize this repo'")
	fmt.Println()
	fmt.Printf("  %sShell integration (recommended):%s\n", dim, reset)
	fmt.Printf("  eval \"$(claude-switch init)\"   %s# add to ~/.zshrc%s\n", dim, reset)
	fmt.Println("  claude -a work                  # launch with work profile")
	fmt.Println("  claude -a personal              # concurrent in another terminal")
	fmt.Println()
	fmt.Printf("  %sSave profiles:%s\n", dim, reset)
	fmt.Println("  claude-switch save personal")
	fmt.Println("  claude /login                   # log into another account")
	fmt.Println("  claude-switch save work")
	fmt.Println()
	fmt.Printf("  %sManual token (if auto-extraction fails):%s\n", dim, reset)
	fmt.Println("  claude setup-token                       # generate token")
	fmt.Println("  claude-switch token work <paste-token>   # save it")
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
	case "token":
		if arg == "" {
			die("Usage: claude-switch token <name> [token]")
		}
		cmdToken(arg, os.Args[3:])
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
