// Copyright (C) 2026 The Syncthing Authors.
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

package api

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const selectiveFileName = ".stselective"
const selectiveHeader = "// Managed by Syncthing Selective Sync. Do not edit manually."

// getDBSelective reads .stselective and reports whether selective sync is
// enabled (i.e. .stignore contains "#include .stselective").
func (s *service) getDBSelective(w http.ResponseWriter, r *http.Request) {
	folderID := r.URL.Query().Get("folder")
	folderCfgs := s.cfg.Folders()
	fcfg, ok := folderCfgs[folderID]
	if !ok {
		http.Error(w, "folder not found", http.StatusNotFound)
		return
	}

	selectivePath := filepath.Join(fcfg.Path, selectiveFileName)
	paths, err := readSelectiveFile(selectivePath)
	if err != nil && !os.IsNotExist(err) {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Check whether .stignore includes .stselective
	ignorePath := filepath.Join(fcfg.Path, ".stignore")
	enabled := fileContainsLine(ignorePath, "#include .stselective")

	sendJSON(w, map[string]interface{}{
		"enabled": enabled,
		"paths":   paths,
	})
}

// postDBSelective writes (or clears) .stselective.
// Body: {"paths": ["string", ...]}  — empty/null clears the file.
func (s *service) postDBSelective(w http.ResponseWriter, r *http.Request) {
	folderID := r.URL.Query().Get("folder")
	folderCfgs := s.cfg.Folders()
	fcfg, ok := folderCfgs[folderID]
	if !ok {
		http.Error(w, "folder not found", http.StatusNotFound)
		return
	}

	bs, err := io.ReadAll(r.Body)
	r.Body.Close()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	var body struct {
		Paths []string `json:"paths"`
	}
	if err := json.Unmarshal(bs, &body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	selectivePath := filepath.Join(fcfg.Path, selectiveFileName)

	if len(body.Paths) == 0 {
		// Disable: remove .stselective if it exists
		if err := os.Remove(selectivePath); err != nil && !os.IsNotExist(err) {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
		return
	}

	// Write .stselective
	sort.Strings(body.Paths)
	var sb strings.Builder
	sb.WriteString(selectiveHeader + "\n")
	for _, p := range body.Paths {
		sb.WriteString("!" + p + "\n")
	}
	sb.WriteString("*\n")

	if err := os.WriteFile(selectivePath, []byte(sb.String()), 0o644); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

// readSelectiveFile parses .stselective and returns the selected paths.
func readSelectiveFile(path string) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return []string{}, err
	}
	defer f.Close()

	var paths []string
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "!/") {
			paths = append(paths, line[1:]) // strip leading !
		}
	}
	if paths == nil {
		paths = []string{}
	}
	return paths, scanner.Err()
}

// fileContainsLine reports whether the file at path contains the given line.
func fileContainsLine(path, needle string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		if scanner.Text() == needle {
			return true
		}
	}
	return false
}
