//go:build windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"
)

const (
	createNoWindow               = 0x08000000
	jobObjectExtendedLimitClass  = 9
	jobObjectLimitKillOnJobClose = 0x2000
	processTerminate             = 0x0001
	processSetQuota              = 0x0100
	processQueryLimited          = 0x1000
)

var (
	kernel32                     = syscall.NewLazyDLL("kernel32.dll")
	procCreateJobObjectW         = kernel32.NewProc("CreateJobObjectW")
	procSetInformationJobObject  = kernel32.NewProc("SetInformationJobObject")
	procAssignProcessToJobObject = kernel32.NewProc("AssignProcessToJobObject")
	procTerminateJobObject       = kernel32.NewProc("TerminateJobObject")
	procOpenProcess              = kernel32.NewProc("OpenProcess")
	procCloseHandle              = kernel32.NewProc("CloseHandle")
	childJob                     syscall.Handle
)

type jobObjectBasicLimitInformation struct {
	PerProcessUserTimeLimit int64
	PerJobUserTimeLimit     int64
	LimitFlags              uint32
	MinimumWorkingSetSize   uintptr
	MaximumWorkingSetSize   uintptr
	ActiveProcessLimit      uint32
	Affinity                uintptr
	PriorityClass           uint32
	SchedulingClass         uint32
}

type ioCounters struct {
	ReadOperationCount  uint64
	WriteOperationCount uint64
	OtherOperationCount uint64
	ReadTransferCount   uint64
	WriteTransferCount  uint64
	OtherTransferCount  uint64
}

type jobObjectExtendedLimitInformation struct {
	BasicLimitInformation jobObjectBasicLimitInformation
	IoInfo                ioCounters
	ProcessMemoryLimit    uintptr
	JobMemoryLimit        uintptr
	PeakProcessMemoryUsed uintptr
	PeakJobMemoryUsed     uintptr
}

func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: createNoWindow,
	}
}

func noWindow(name string, args ...string) *exec.Cmd {
	cmd := exec.Command(name, args...)
	hideWindow(cmd)
	return cmd
}

func taskkillBin() string {
	p := filepath.Join(os.Getenv("SystemRoot"), "System32", "taskkill.exe")
	if _, err := os.Stat(p); err == nil {
		return p
	}
	return "taskkill"
}

func tasklistBin() string {
	p := filepath.Join(os.Getenv("SystemRoot"), "System32", "tasklist.exe")
	if _, err := os.Stat(p); err == nil {
		return p
	}
	return "tasklist"
}

func openBrowser(url string) {
	// Prefer a dedicated fullscreen app window so the panel fills the screen.
	browsers := []struct {
		path string
		args []string
	}{
		{`C:\Program Files\Google\Chrome\Application\chrome.exe`, []string{"--start-fullscreen", "--app=" + url}},
		{`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`, []string{"--start-fullscreen", "--app=" + url}},
		{`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`, []string{"--start-fullscreen", "--app=" + url}},
		{`C:\Program Files\Microsoft\Edge\Application\msedge.exe`, []string{"--start-fullscreen", "--app=" + url}},
	}
	for _, b := range browsers {
		if _, err := os.Stat(b.path); err == nil {
			cmd := exec.Command(b.path, b.args...)
			if err := cmd.Start(); err == nil {
				return
			}
		}
	}
	_ = exec.Command("cmd", "/c", "start", "", url).Start()
}

func killPort(port string) {
	out, err := noWindow("netstat", "-ano").Output()
	if err != nil {
		return
	}
	for _, pid := range listeningPIDs(string(out), port) {
		killPIDTree(pid)
	}
}

func killPIDTree(pid string) {
	_ = noWindow(taskkillBin(), "/F", "/T", "/PID", pid).Run()
}

func listNodePIDs() []string {
	var all []string
	seen := map[string]bool{}
	for _, name := range []string{"node.exe", "npm.exe", "tsx.exe"} {
		out, err := noWindow(tasklistBin(), "/FI", "IMAGENAME eq "+name, "/FO", "CSV", "/NH").Output()
		if err != nil {
			continue
		}
		for _, pid := range parseTasklistCSV(string(out)) {
			if seen[pid] {
				continue
			}
			seen[pid] = true
			all = append(all, pid)
		}
	}
	return all
}

func killMatchingNode(root string) {
	_ = root
	terminateJob()
	for _, img := range []string{"node.exe", "npm.exe", "tsx.exe"} {
		_ = noWindow(taskkillBin(), "/F", "/T", "/IM", img).Run()
	}
	for _, pid := range listNodePIDs() {
		killPIDTree(pid)
	}
}

func ensureJob() {
	if childJob != 0 {
		return
	}
	h, _, _ := procCreateJobObjectW.Call(0, 0)
	if h == 0 {
		return
	}
	job := syscall.Handle(h)
	var info jobObjectExtendedLimitInformation
	info.BasicLimitInformation.LimitFlags = jobObjectLimitKillOnJobClose
	procSetInformationJobObject.Call(
		uintptr(job),
		uintptr(jobObjectExtendedLimitClass),
		uintptr(unsafe.Pointer(&info)),
		unsafe.Sizeof(info),
	)
	childJob = job
}

func trackChild(pid int) {
	if pid <= 0 {
		return
	}
	ensureJob()
	if childJob == 0 {
		return
	}
	ph, _, _ := procOpenProcess.Call(processTerminate|processSetQuota|processQueryLimited, 0, uintptr(uint32(pid)))
	if ph == 0 {
		return
	}
	procAssignProcessToJobObject.Call(uintptr(childJob), ph)
	procCloseHandle.Call(ph)
}

func terminateJob() {
	if childJob == 0 {
		return
	}
	procTerminateJobObject.Call(uintptr(childJob), 1)
}
