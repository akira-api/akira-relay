import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { Metrics, getCutoffDate } from "../src/shared/metrics.js";

const secret = "test-secret-at-least-32-characters-long-key";

describe("Bandwidth Persistence & 30-Day Retention", () => {
  it("persists bandwidth across server restarts using SQLite file", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akira-bw-persist-"));
    const dbPath = path.join(tmpDir, "relay.db");

    try {
      // Instance 1: stream 15 MB
      const { app: app1, metrics: metrics1 } = await createServer({
        secret,
        sqliteDbPath: dbPath,
        internalRelayKey: "",
      });

      metrics1.recordStreamStart("acefile", "1080p");
      metrics1.recordStreamBytes(1048576 * 15, "acefile"); // 15 MB
      metrics1.recordStreamEnd("acefile");

      await app1.close();

      // Instance 2: start new server on same sqlite database
      const { app: app2, metrics: metrics2 } = await createServer({
        secret,
        sqliteDbPath: dbPath,
        internalRelayKey: "",
      });

      const res = await app2.inject({
        method: "GET",
        url: "/internal/stats",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.bandwidth.totalStreamedMB).toBe(15);
      expect(body.bandwidth.retentionDays).toBe(30);
      expect(body.streams.bytesStreamed).toBe(1048576 * 15);
      expect(body.streams.byProvider.acefile.bytesStreamedMB).toBe(15);

      // Stream additional 5 MB on Instance 2
      metrics2.recordStreamBytes(1048576 * 5, "acefile");

      const resAfter = await app2.inject({
        method: "GET",
        url: "/internal/stats",
      });
      const bodyAfter = JSON.parse(resAfter.body);
      expect(bodyAfter.bandwidth.totalStreamedMB).toBe(20);

      await app2.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("prunes bandwidth usage older than 30 days and retains recent usage", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akira-bw-retention-"));
    const dbPath = path.join(tmpDir, "relay.db");

    try {
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE bandwidth_daily (
          date TEXT NOT NULL,
          provider TEXT NOT NULL,
          bytes INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (date, provider)
        );
      `);

      // 40 days ago (should be purged)
      const d40 = new Date();
      d40.setUTCDate(d40.getUTCDate() - 40);
      const dateOld = d40.toISOString().slice(0, 10);

      // 10 days ago (should be kept)
      const d10 = new Date();
      d10.setUTCDate(d10.getUTCDate() - 10);
      const dateRecent = d10.toISOString().slice(0, 10);

      db.prepare("INSERT INTO bandwidth_daily VALUES (?, ?, ?)").run(
        dateOld,
        "blogger",
        1048576 * 50, // 50 MB
      );
      db.prepare("INSERT INTO bandwidth_daily VALUES (?, ?, ?)").run(
        dateRecent,
        "blogger",
        1048576 * 20, // 20 MB
      );
      db.close();

      const metrics = new Metrics({ dbPath, retentionDays: 30 });

      expect(metrics.streams.bytesStreamed).toBe(1048576 * 20);
      expect(metrics.getBandwidthStats().totalStreamedMB).toBe(20);

      // Verify old entry was deleted from DB
      const checkDb = new Database(dbPath);
      const rows = checkDb.prepare("SELECT * FROM bandwidth_daily").all() as any[];
      checkDb.close();

      expect(rows.length).toBe(1);
      expect(rows[0].date).toBe(dateRecent);

      metrics.destroy();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resets bandwidth via resetBandwidth", () => {
    const metrics = new Metrics({ retentionDays: 30 });
    metrics.recordStreamBytes(1048576 * 30, "blogger");
    metrics.flush();

    expect(metrics.getBandwidthStats().totalStreamedMB).toBe(30);

    metrics.resetBandwidth();

    expect(metrics.getBandwidthStats().totalStreamedMB).toBe(0);
    expect(metrics.streams.bytesStreamed).toBe(0);
    metrics.destroy();
  });
});
