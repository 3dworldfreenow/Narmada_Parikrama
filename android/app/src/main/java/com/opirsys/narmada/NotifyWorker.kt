package com.opirsys.narmada

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters

/** Every ~15 minutes, even when the app is closed: check for family photo requests and new family photos. */
class NotifyWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    override fun doWork(): Result {
        Net.checkNotify(applicationContext)
        return Result.success()
    }
}
