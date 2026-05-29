// Package updater self-updates the daemon (and optionally the bundled
// extension) from the project's GitHub Releases. No third-party deps — just the
// stdlib HTTP client and archive/zip.
package updater

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/zhizuzhefu/open-webbridge/open-webbridge-daemon/internal/config"
)

const apiLatest = "https://api.github.com/repos/%s/releases/latest"

func client() *http.Client { return &http.Client{Timeout: 90 * time.Second} }

// Platform is the release asset suffix for the current host, e.g. "darwin-arm64".
func Platform() string { return runtime.GOOS + "-" + runtime.GOARCH }

// LatestVersion returns the newest published release version (without a leading
// "v").
func LatestVersion(ctx context.Context) (string, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf(apiLatest, config.Repo), nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := client().Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("github API returned %d", resp.StatusCode)
	}
	var r struct {
		TagName string `json:"tag_name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return "", err
	}
	if r.TagName == "" {
		return "", errors.New("release has no tag_name")
	}
	return strings.TrimPrefix(r.TagName, "v"), nil
}

// UpdateAvailable reports whether the latest release is newer than current.
func UpdateAvailable(ctx context.Context) (latest string, available bool, err error) {
	latest, err = LatestVersion(ctx)
	if err != nil {
		return "", false, err
	}
	return latest, config.CompareVersions(latest, config.Version) > 0, nil
}

func downloadURL(version, asset string) string {
	return fmt.Sprintf("https://github.com/%s/releases/download/v%s/%s", config.Repo, version, asset)
}

func download(ctx context.Context, url, dst string) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	resp, err := client().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download %s: HTTP %d", url, resp.StatusCode)
	}
	f, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(f, resp.Body)
	return err
}

// InstallBinary downloads the daemon binary for `version` and atomically swaps
// it into place. Returns the path it wrote.
func InstallBinary(ctx context.Context, version string) (string, error) {
	target := config.BinInstallPath()
	if _, err := os.Stat(target); err != nil {
		if exe, e := os.Executable(); e == nil {
			target = exe // dev/other install location
		}
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return "", err
	}
	asset := "open-webbridge-" + Platform()
	tmp := target + ".new"
	if err := download(ctx, downloadURL(version, asset), tmp); err != nil {
		return "", err
	}
	if err := os.Chmod(tmp, 0o755); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	if err := os.Rename(tmp, target); err != nil { // atomic on same filesystem
		_ = os.Remove(tmp)
		return "", err
	}
	signMacOS(target)
	return target, nil
}

// signMacOS ad-hoc signs the binary on macOS and clears the quarantine
// attribute. Apple Silicon refuses to execute unsigned binaries ("killed: 9"),
// and a freshly downloaded release binary (cross-compiled, unsigned) would be
// killed on launch without this. Ad-hoc signing needs no Apple Developer account.
func signMacOS(path string) {
	if runtime.GOOS != "darwin" {
		return
	}
	_ = exec.Command("xattr", "-dr", "com.apple.quarantine", path).Run()
	_ = exec.Command("codesign", "--force", "--sign", "-", path).Run()
}

// NOTE: the daemon does not self-host or update the extension — the extension
// is distributed via the Chrome Web Store, which auto-updates it. Only the
// daemon binary self-updates here.
