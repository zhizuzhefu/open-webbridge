package config

import (
	"os"
	"path/filepath"
	"testing"
)

// TestAutoUpdateDefaultsOnFreshInstall verifies a first run (no config.json)
// creates a config with auto-update enabled.
func TestAutoUpdateDefaultsOnFreshInstall(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	c, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !c.AutoUpdate {
		t.Fatal("fresh install should default AutoUpdate=true")
	}
}

// TestExistingAutoUpdateFalseIsPreserved verifies that an existing config with
// auto_update=false is left off — flipping the default must not re-enable users.
func TestExistingAutoUpdateFalseIsPreserved(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := EnsureDirs(); err != nil {
		t.Fatalf("EnsureDirs: %v", err)
	}
	const existing = `{"host":"127.0.0.1","port":9234,"token":"abc","auto_update":false}`
	if err := os.WriteFile(filepath.Join(BaseDir(), "config.json"), []byte(existing), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	c, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.AutoUpdate {
		t.Fatal("existing auto_update=false must be preserved, not re-enabled")
	}
}
