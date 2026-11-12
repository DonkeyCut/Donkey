// The job kinds an editor command batch runs as. The editor in the ChatGPT
// card claims a "commands" row; one no card claimed in time becomes a
// "worker_commands" row, which the cloud worker runs on the saved project.
export const EDITOR_BATCH = "commands";
export const WORKER_BATCH = "worker_commands";
