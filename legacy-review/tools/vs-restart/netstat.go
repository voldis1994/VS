package main

import (
	"encoding/csv"
	"strings"
)

func listeningPIDs(netstatOut, port string) []string {
	seen := map[string]bool{}
	var pids []string
	for _, line := range strings.Split(netstatOut, "\n") {
		u := strings.ToUpper(line)
		if !strings.Contains(u, "LISTENING") && !strings.Contains(u, "LISTEN") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		local := fields[1]
		if !localAddrHasPort(local, port) {
			continue
		}
		pid := fields[len(fields)-1]
		if slash := strings.Index(pid, "/"); slash >= 0 {
			pid = pid[:slash]
		}
		pid = strings.TrimSpace(pid)
		if pid == "" || pid == "0" || seen[pid] {
			continue
		}
		seen[pid] = true
		pids = append(pids, pid)
	}
	return pids
}

func localAddrHasPort(local, port string) bool {
	local = strings.TrimSpace(local)
	if local == "" || port == "" {
		return false
	}
	return strings.HasSuffix(local, ":"+port)
}

func parseTasklistCSV(out string) []string {
	s := strings.TrimSpace(out)
	if s == "" || strings.HasPrefix(strings.ToUpper(s), "INFO:") {
		return nil
	}
	r := csv.NewReader(strings.NewReader(s))
	r.FieldsPerRecord = -1
	seen := map[string]bool{}
	var pids []string
	for {
		rec, err := r.Read()
		if err != nil {
			break
		}
		if len(rec) < 2 {
			continue
		}
		name := strings.ToLower(strings.TrimSpace(rec[0]))
		if name != "node.exe" && name != "npm.exe" && name != "tsx.exe" {
			continue
		}
		pid := strings.TrimSpace(rec[1])
		if pid == "" || pid == "0" || seen[pid] {
			continue
		}
		seen[pid] = true
		pids = append(pids, pid)
	}
	return pids
}
