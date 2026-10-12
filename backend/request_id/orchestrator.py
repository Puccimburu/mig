
import logging

import config
import extractor
import scraper
import file_generator

logger = logging.getLogger(__name__)

# Statuses that mean "the site hasn't finished processing this record
# yet" -- leave it empty and pick it up on a future run.
NOT_READY_STATUSES = {'New', 'In Progress'}

# These two statuses both get the literal status text in Record ID
# instead of opening the detail tab (per spec: "dont open tose ... add
# (Partially Completed)" and "on this we just add failed") -- but they
# differ on Request ID: a Partially Completed record still has a real
# one (RECORD DETAILS has a real link, confirmed against the spec's own
# example: "(91987)"), while a Failed record has none at all (RECORD
# DETAILS is a bare '-' with no link, confirmed on a real failed
# import -- scraper.py normalizes that to ''). We write 'Not Applicable'
# for a Failed row's Request ID (matching the site's own term for this,
# e.g. "AI RETRY STATUS: Not Applicable") rather than leaving it truly
# blank, so the row still counts as fully processed and isn't retried
# forever waiting for a Request ID that will never come.
PARTIALLY_COMPLETED_STATUS = 'Partially Completed'
FAILED_STATUS = 'Failed'
LITERAL_RECORD_ID_STATUSES = {PARTIALLY_COMPLETED_STATUS, FAILED_STATUS}


def main():
    run_id, run_dir, latest_dir = file_generator.new_run_paths()
    log_path = file_generator.setup_logging(run_id)
    logger.info(f'=== Request Id Populator run {run_id} starting (log: {log_path}) ===')

    result = {
        'success': False,
        'run_id': run_id,
        'processed': 0,
        'skipped_not_ready': 0,
        'skipped_no_match': 0,
        'fully_completed': False,
        'errors': [],
    }

    input_path = extractor.find_input_workbook()
    if not input_path:
        logger.info('no .xlsx file found in input/ -- nothing to do')
        result['success'] = True
        result['skipped'] = True
        return result
    logger.info(f'input workbook: {input_path}')

    wb = extractor.load_workbook(input_path)
    extractor.ensure_output_columns(wb, input_path)
    pending = extractor.get_pending_rows(wb)
    logger.info(f'{len(pending)} row(s) still need Request ID / Record ID / File Names / File Path')

    supporting_index = {}
    if config.ENABLE_SUPPORTING_DOCUMENTS:
        extractor.ensure_supporting_doc_columns(wb, input_path)
        supporting_index = extractor.build_supporting_doc_index(wb)
        logger.info(f'supporting documents: {len(supporting_index)} tracked row(s) in '
                    f"{extractor.SUPPORTING_SHEET_NAME!r}")

    csv_report = file_generator.CsvReport(run_dir, latest_dir)
    driver = None
    try:
        if pending:
            driver = scraper.build_driver()
            if not scraper.login(driver):
                raise RuntimeError('login failed')
            scraper.goto_bulk_import_upload(driver)
            scraper.open_matched_batch_report(
                driver, config.BULK_IMPORT_TEMPLATE, config.UPLOADED_ON, config.TOTAL_COUNT
            )
            records = scraper.collect_report_records(driver)
            by_ref = {r['RECORD REFERENCE ID']: r for r in records}
            logger.info(f'matched batch report has {len(records)} record(s)')

            def _write_and_log(row_idx, ref_id, request_id, record_id, file_names, file_path,
                                status, detail_href, error_message='', supporting_docs=None):
                for doc in (supporting_docs or []):
                    sup_row = supporting_index.get((ref_id, doc.get('document_reference_id', '')))
                    if sup_row is None:
                        logger.warning(f'row {row_idx}: no {extractor.SUPPORTING_SHEET_NAME!r} row for '
                                        f"Record Reference Id={ref_id!r}, Document Reference Id="
                                        f"{doc.get('document_reference_id')!r} -> skipping that document")
                        continue
                    extractor.write_supporting_doc(
                        wb, sup_row,
                        doc_id=doc.get('id'), filename=doc.get('filename'), file_path=doc.get('file_path'),
                        status=doc.get('status'), error_message=doc.get('error_message'),
                        parent_request_id=request_id, parent_record_id=record_id,
                    )
                # write_row() saves the whole workbook, so the supporting-doc
                # cell writes above are persisted together with this record's
                # own row in one save -- no separate save call needed here.
                extractor.write_row(
                    wb, input_path, row_idx,
                    request_id=request_id, record_id=record_id,
                    file_names=file_names, file_path=file_path,
                )
                csv_report.add(
                    record_reference_id=ref_id, request_id=request_id, record_id=record_id,
                    file_names=file_names, file_path=file_path, status=status,
                    detail_url=detail_href, error_message=error_message,
                )
                logger.info(f'row {row_idx}: Record Reference Id={ref_id} -> Request ID={request_id}, '
                            f'Record ID={record_id}, File Names={file_names!r}, File Path={file_path!r}')
                result['processed'] += 1

            # Pass 1: classify. Partially Completed / Failed rows already
            # have everything they need and get written immediately;
            # Completed rows need their Record ID confirmed on the
            # (slow) contract-snapshot page, so those are queued and
            # confirmed together via confirm_many's tab pool instead of
            # one at a time -- that's the actual bottleneck at scale
            # (measured ~10-20s/record serially; batching several as
            # concurrent tabs in the same session cuts that meaningfully,
            # see confirm_many's docstring).
            needs_confirmation = []  # (row_idx, ref_id, request_id, file_names, file_path, detail_href, supporting_docs)
            for item in pending:
                row_idx = item['row']
                ref_id = item['record_reference_id']
                rec = by_ref.get(ref_id)

                if rec is None:
                    logger.warning(f'row {row_idx}: no report record for Record Reference Id={ref_id!r} -> skipping')
                    result['skipped_no_match'] += 1
                    continue

                status = rec.get('STATUS', '')
                request_id = rec.get('REQUEST_ID', '')
                file_names = rec.get('FILE_NAMES', '')
                file_path = rec.get('FILE_PATHS', '')
                detail_href = rec.get('_detail_href') or ''
                error_message = rec.get('ERROR MESSAGE', '')
                if error_message == '-':
                    error_message = ''
                supporting_docs = rec.get('SUPPORTING_DOCS', [])

                if status in NOT_READY_STATUSES:
                    logger.info(f'row {row_idx}: Record Reference Id={ref_id} status={status!r} -> not ready, skipping')
                    result['skipped_not_ready'] += 1
                    continue

                if status in LITERAL_RECORD_ID_STATUSES:
                    record_id = status
                    if status == FAILED_STATUS and not request_id:
                        request_id = FAILED_STATUS  # 'Failed' in both cells -- clearer than mixing terms
                    _write_and_log(row_idx, ref_id, request_id, record_id, file_names, file_path,
                                   status, detail_href, error_message, supporting_docs=supporting_docs)
                elif status == 'Completed':
                    needs_confirmation.append((row_idx, ref_id, request_id, file_names, file_path,
                                                detail_href, supporting_docs))
                else:
                    logger.warning(f'row {row_idx}: unrecognized status {status!r} -> skipping')
                    result['skipped_no_match'] += 1

            # Pass 2: confirm all queued Completed records together.
            if needs_confirmation:
                request_ids = [t[2] for t in needs_confirmation]
                logger.info(f'confirming {len(request_ids)} Completed record(s) '
                            f'(up to {config.MAX_CONCURRENT_TABS} concurrent tabs)...')
                confirmed = scraper.confirm_many(driver, request_ids, max_tabs=config.MAX_CONCURRENT_TABS)

                for row_idx, ref_id, request_id, file_names, file_path, detail_href, supporting_docs in needs_confirmation:
                    record_id = confirmed.get(request_id)
                    if record_id is None:
                        logger.error(f'row {row_idx}: could not confirm Record ID for Request ID={request_id} -> skipping, will retry next run')
                        result['errors'].append(f'row {row_idx}: Record ID confirmation failed for Request ID {request_id}')
                        continue
                    _write_and_log(row_idx, ref_id, request_id, record_id, file_names, file_path, 'Completed',
                                    detail_href, supporting_docs=supporting_docs)
    except Exception as e:
        logger.exception('pipeline run failed')
        result['errors'].append(str(e))
        if driver is not None:
            scraper.dump_failure_state(driver, run_dir)
    finally:
        csv_report.close()
        if driver is not None:
            driver.quit()

    file_generator.snapshot_workbook(input_path, run_dir, latest_dir)

    wb2 = extractor.load_workbook(input_path)
    fully_done = extractor.is_fully_populated(wb2)
    result['fully_completed'] = fully_done
    if fully_done:
        file_generator.cleanup_input(input_path)
    else:
        logger.info('workbook not yet fully populated -- left in input/ to resume next run')

    result['success'] = not result['errors']
    logger.info(f'=== run {run_id} finished: processed={result["processed"]}, '
                f'skipped_not_ready={result["skipped_not_ready"]}, '
                f'skipped_no_match={result["skipped_no_match"]}, '
                f'fully_completed={fully_done} ===')
    return result


if __name__ == '__main__':
    import sys
    logging.basicConfig(level=logging.INFO)
    r = main()
    sys.exit(0 if r['success'] else 1)
