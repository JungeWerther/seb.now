-- property-extract and place-resolve both fired at :07 of every ten minutes;
-- :08 is the free slot between place-resolve (:07) and index-snapshot (:09).
select cron.alter_job(jobid, schedule := '8-59/10 * * * *')
from cron.job
where jobname = 'property-extract';
