# CTest uses the current attempt directory without rewriting the build cache.
if(DEFINED ENV{ABANDON_CAPTURE_TEST_RESULT_DIRECTORY} AND NOT "$ENV{ABANDON_CAPTURE_TEST_RESULT_DIRECTORY}" STREQUAL "")
  set(result_directory "$ENV{ABANDON_CAPTURE_TEST_RESULT_DIRECTORY}")
else()
  set(result_directory "${DEFAULT_RESULT_DIRECTORY}")
endif()
file(MAKE_DIRECTORY "${result_directory}")
execute_process(COMMAND "${TEST_EXECUTABLE}"
  -o "${result_directory}/${TEST_NAME}.txt,txt"
  -o "${result_directory}/${TEST_NAME}.junit.xml,junitxml"
  RESULT_VARIABLE result)
if(NOT result EQUAL 0)
  message(FATAL_ERROR "${TEST_NAME} failed: ${result}")
endif()
