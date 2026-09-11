package gateway

import (
	"errors"
	"os"
)

const nodeCostMarker = "AMR_NODE_COST_OBSERVATION_V1\n"

// Prevent a dormant Go ledger from being mistaken for the current Node cost
// observations during a later mode change or offline rollback.
func checkCostAuthority(path string, node bool) (bool, error) {
	data, err := os.ReadFile(path + ".node-observation")
	if err == nil {
		if !node || string(data) != nodeCostMarker {
			return false, errors.New("cost authority requires controlled migration from Node observations")
		}
		return true, nil
	}
	if !os.IsNotExist(err) {
		return false, errors.New("cost authority marker unavailable")
	}
	if node {
		if info, e := os.Stat(path); e == nil && info.Size() != 0 {
			return false, errors.New("Node observations require a fresh Go state path")
		} else if e != nil && !os.IsNotExist(e) {
			return false, e
		}
	}
	return false, nil
}
func writeCostAuthority(path string) error {
	f, err := os.OpenFile(path+".node-observation", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, err = f.WriteString(nodeCostMarker)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = auditSyncDir(path + ".node-observation")
	}
	return err
}
