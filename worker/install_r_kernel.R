args <- commandArgs(trailingOnly = TRUE)
if (length(args) != 1L) stop("Pass the app-local R library directory")
library_dir <- normalizePath(args[[1L]], winslash = "/", mustWork = FALSE)
dir.create(library_dir, recursive = TRUE, showWarnings = FALSE)
.libPaths(c(library_dir, .Library))
install.packages(c("IRkernel", "jsonlite"), lib = library_dir,
                 repos = "https://cloud.r-project.org", type = "binary")
stopifnot(requireNamespace("IRkernel", quietly = TRUE),
          requireNamespace("jsonlite", quietly = TRUE))
cat(jsonlite::toJSON(list(r = R.version.string, library = library_dir,
                         IRkernel = as.character(packageVersion("IRkernel"))),
                    auto_unbox = TRUE), "\n")
