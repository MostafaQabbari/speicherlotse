## Consequences

Measured on one development laptop (Windows, Docker Desktop, 4 logical CPUs, default durability, TimescaleDB 2.29.2 on PostgreSQL 18, 100 simulated devices, batches of 1,000 rows). A server with a fast disk will differ; the load report repeats these runs on the target machine.

- Row size is 222 B uncompressed, not 150 B: 134.5 B table plus 87.5 B primary-key index. For 1,000 systems that is 86.4 million rows and about 19 GB per day before compression.
- Compression: 1 million rows went from 213 MiB to 18 MiB, about 12x (roughly 19 B per row), which is inside the 10x to 20x assumption at its low end. The test used one chunk of smooth simulated data, so real telemetry may compress worse. Disk for the demo fleet (about one day uncompressed plus 13 days compressed) is roughly 40 to 45 GB, about 1.5 times the 21 to 30 GB of ADR-001.
- Writer throughput is not 50,000 rows/s. On this laptop (Intel i5-6300U, 2 cores and 4 threads, 16 GB RAM, Docker Desktop with 7.7 GiB) one connection inserts 7,000 to 9,000 rows/s, four connections about 15,000 rows/s. A plain PostgreSQL table in the same container reached 7,800 rows/s, so TimescaleDB is not the limit. Skipping the commit wait (`synchronous_commit` off) raised the speed by 28% to 11,400 rows/s, so the disk flush is a minor part. Generating and serialising the batches in Node is a small part as well (about 1.4 s per 300,000 rows when measured on another machine). What remains is the database inside Docker on a small laptop CPU; CPU load during a run was not measured.
- The 1,000-system demo needs 1,000 rows/s, so one writer has 7x to 9x headroom. With 1,000 live systems, a 6-hour backfill of 21.6 million rows drains in about 50 to 60 minutes.
- The 10,000-system target needs 10,000 rows/s of live traffic, more than one connection can write. It needs parallel writers (one consumer per group of partitions); at about 15,000 rows/s the backfill spare capacity is 5,000 rows/s and the drain takes about 72 minutes.

## Still to measure

| Item | How |
|---|---|
| Why one connection stops at about 9,000 rows/s (CPU of the Docker VM, virtual disk, or Windows networking) | Task Manager and `docker stats` during a 1-million-row run; the same bench on a Linux machine |
| What limits the writer here (disk flush, CPU, or Docker) | bench with `BENCH_SYNC_OFF=1`, and `docker stats` during a run |
| Insert into an already compressed chunk (device back after 2 days) | bench with timestamps older than 1 day |
| Throughput with Kafka in front of the writer | Step 2e, then load report v1 |
| Compression ratio on noisier data | fault-injection data from the fleet simulator |