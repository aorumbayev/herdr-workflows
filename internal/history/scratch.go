package history

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/caps"
	"github.com/aorumbayev/herdr-workflows/internal/config"
)

func ScratchGet(key string, getenv config.Env) (string, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	if key == "" {
		return "", fmt.Errorf("scratch key is required")
	}
	db, err := openHistory(getenv)
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

func ScratchSet(key, value string, getenv config.Env) error {
	if getenv == nil {
		getenv = os.Getenv
	}
	if key == "" {
		return fmt.Errorf("scratch key is required")
	}
	if err := caps.AssertUnderCaptureCap("scratch", value); err != nil {
		return err
	}
	db, err := openHistory(getenv)
	if err != nil {
		return err
	}
	_, err = db.Exec(`INSERT INTO scratch(key, value, updated_at) VALUES(?,?,?)
		ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
		key, value, time.Now().UTC().Format("2006-01-02T15:04:05.000Z"))
	return err
}

func ScratchList(getenv config.Env) ([]string, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	db, err := openHistory(getenv)
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

func ScratchDelete(key string, getenv config.Env) error {
	if getenv == nil {
		getenv = os.Getenv
	}
	if key == "" {
		return fmt.Errorf("scratch key is required")
	}
	db, err := openHistory(getenv)
	if err != nil {
		return err
	}
	_, err = db.Exec(`DELETE FROM scratch WHERE key=?`, key)
	return err
}
