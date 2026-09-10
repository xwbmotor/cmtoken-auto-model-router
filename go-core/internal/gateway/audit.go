package gateway

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
)

// The ledger lock must already be held. Audit is supplementary to the WAL;
// an incomplete last audit line is recoverable, a damaged complete line is not.
func openAudit(path string) (*auditJournal, error) {
	f, e := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return nil, e
	}
	fail := func(e error) (*auditJournal, error) { f.Close(); return nil, e }
	reader := bufio.NewReaderSize(f, 16384)
	var offset int64
	for {
		line, err := reader.ReadSlice('\n')
		if err == io.EOF {
			if len(line) > 0 {
				if offset == 0 && !bytes.HasPrefix(line, []byte(`{"requestId":`)) {
					return fail(errors.New("not an audit journal"))
				}
				if e = f.Truncate(offset); e != nil {
					return fail(e)
				}
			}
			break
		}
		if err != nil || len(line) > 16384 || !json.Valid(bytes.TrimSpace(line)) {
			return fail(errors.New("invalid audit journal"))
		}
		offset += int64(len(line))
	}
	if _, e = f.Seek(0, io.SeekEnd); e != nil {
		return fail(e)
	}
	if e = f.Sync(); e != nil {
		return fail(e)
	}
	j := &auditJournal{file: f, queue: make(chan *auditEntry, 256), stopped: make(chan struct{}), syncFile: f.Sync}
	go j.writeLoop()
	return j, nil
}
