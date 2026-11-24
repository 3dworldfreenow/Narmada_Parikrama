package com.opirsys.narmada

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Timeline points recorded on the phone (also while offline / screen off).
 * Stored as one JSON object per line; the web UI uploads them and then clears them.
 */
object PointStore {
    private const val FILE = "timeline_points.jsonl"
    private val lock = Any()

    private fun file(ctx: Context) = File(ctx.filesDir, FILE)

    fun add(ctx: Context, lat: Double, lng: Double, acc: Float, ts: Double) {
        val o = JSONObject().put("lat", lat).put("lng", lng).put("acc", acc.toDouble()).put("ts", ts)
        synchronized(lock) { file(ctx).appendText(o.toString() + "\n") }
    }

    /** Up to [limit] oldest points as a JSON array string. */
    fun read(ctx: Context, limit: Int): String {
        val arr = JSONArray()
        synchronized(lock) {
            val f = file(ctx)
            if (f.exists()) f.useLines { lines ->
                lines.filter { it.isNotBlank() }.take(limit).forEach { runCatching { arr.put(JSONObject(it)) } }
            }
        }
        return arr.toString()
    }

    fun count(ctx: Context): Int = synchronized(lock) {
        val f = file(ctx); if (!f.exists()) 0 else f.useLines { l -> l.count { it.isNotBlank() } }
    }

    /** Remove points with ts <= [upToTs] (they were uploaded). */
    fun clearUpTo(ctx: Context, upToTs: Double) {
        synchronized(lock) {
            val f = file(ctx)
            if (!f.exists()) return
            val keep = f.readLines().filter { line ->
                line.isNotBlank() && runCatching { JSONObject(line).getDouble("ts") > upToTs }.getOrDefault(false)
            }
            f.writeText(if (keep.isEmpty()) "" else keep.joinToString("\n", postfix = "\n"))
        }
    }
}
