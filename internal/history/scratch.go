package history

import (
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/caps"
)

func ScratchGet(key string) (string, error) {
	if key == "" {
		return "", fmt.Errorf("scratch key is required")
	}
	db, err := openHistory()
	if err != nil {
		return "", err
	}
	var value string
	err = db.QueryRow(`SELECT value FROM scratch WHERE key=?`, key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", fmt.Errorf("scratch key %q not found", key)
	}
	return value, err
}

func ScratchSet(key, value string) error {
	if key == "" {
		return fmt.Errorf("scratch key is required")
	}
	if err := caps.AssertUnderCaptureCap("scratch", value); err != nil {
		return err
	}
	db, err := openHistory()
	if err != nil {
		return err
	}
	_, err = db.Exec(`INSERT INTO scratch(key, value, updated_at) VALUES(?,?,?)
		ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
		key, value, time.Now().UTC().Format("2006-01-02T15:04:05.000Z"))
	return err
}

func ScratchList() ([]string, error) {
	db, err := openHistory()
	if err != nil {
		return nil, err
	}
	rows, err := db.Query(`SELECT key FROM scratch ORDER BY key`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []string
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			return nil, err
		}
		out = append(out, key)
	}
	return out, rows.Err()
}

func ScratchDelete(key string) error {
	if key == "" {
		return fmt.Errorf("scratch key is required")
	}
	db, err := openHistory()
	if err != nil {
		return err
	}
	_, err = db.Exec(`DELETE FROM scratch WHERE key=?`, key)
	return err
}
