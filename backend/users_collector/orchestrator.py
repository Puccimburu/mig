import logging
import math

import config
import scraper
import file_generator

logger = logging.getLogger(__name__)


def main():
    run_id, run_dir, latest_dir = file_generator.new_run_paths()
    log_path = file_generator.setup_logging(run_id)
    logger.info(f'=== Users Collector run {run_id} starting (log: {log_path}) ===')

    result = {
        'success': False,
        'run_id': run_id,
        'users_collected': 0,
        'pages_processed': 0,
        'total_users': None,
        'duplicates_skipped': 0,
        'errors': [],
    }

    driver = None
    xlsx   = file_generator.XlsxWriter(run_dir, latest_dir)
    try:
        driver = scraper.build_driver()

        if not scraper.login(driver):
            raise RuntimeError('login failed')

        scraper.goto_users_page(driver)

        # Wait for the table data to fully load (spinner gone, footer with
        # per-page selector rendered) BEFORE attempting to click the per-page
        # button. The selector lives below the table and only appears once the
        # table body has finished loading.
        scraper._wait_for_table_data(driver)

        # The page size click has been seen to fail on a page that hadn't
        # settled; retry, then use whatever size the footer actually shows
        # rather than assuming the requested one.
        showing = None
        for attempt in range(1, 4):
            scraper.set_report_page_size(driver, config.REPORT_PAGE_SIZE)
            scraper._wait_for_table_data(driver)
            showing = scraper.read_showing(driver)
            if showing and (showing[1] - showing[0] + 1 == config.REPORT_PAGE_SIZE
                            or showing[1] == showing[2]):
                break
            logger.warning(f'page size attempt {attempt}: footer shows {showing}')
        if not showing:
            raise RuntimeError('could not read the "Showing X to Y of Z results" footer')

        first, last, total = showing
        if first != 1:
            raise RuntimeError(f'expected the table to start at row 1, footer shows {showing}')
        per_page = last - first + 1
        total_pages = min(math.ceil(total / per_page), config.MAX_PAGES)
        result['total_users'] = total
        logger.info(f'{total} users across {total_pages} page(s) at {per_page}/page')

        col = config.USER_DATA_COLUMNS
        sl  = config.CELL_DATA_SLICE
        seen = set()

        for page_num in range(1, total_pages + 1):
            if page_num > 1:
                showing = scraper.goto_page_verified(driver, page_num, per_page)

            raw_rows = scraper._read_page_via_js(driver)
            page_records = []
            for cells in raw_rows:
                if len(cells) < 9:
                    continue
                data = cells[sl]
                if not any(data) or 'spinning' in ' '.join(data).lower():
                    continue
                record = dict(zip(col, data))
                email = record.get('Email', '').strip().lower()
                if email and email in seen:
                    result['duplicates_skipped'] += 1
                    continue
                if email:
                    seen.add(email)
                page_records.append(record)

            expected_rows = showing[1] - showing[0] + 1
            if len(raw_rows) < expected_rows:
                logger.warning(f'page {page_num}: footer says {expected_rows} rows, '
                               f'table has {len(raw_rows)}')

            xlsx.add_page(page_records)
            result['users_collected'] += len(page_records)
            result['pages_processed'] += 1
            logger.info(f'page {page_num}/{total_pages}: {len(page_records)} user(s)  '
                        f'(total so far: {result["users_collected"]})')

        accounted = result['users_collected'] + result['duplicates_skipped']
        if accounted < total:
            raise RuntimeError(f'collected {result["users_collected"]} of {total} users '
                               f'({result["duplicates_skipped"]} duplicates skipped); '
                               f'{total - accounted} missing')
        if result['duplicates_skipped']:
            logger.warning(f'{result["duplicates_skipped"]} rows repeated an email already '
                           f'collected and were skipped')

    except Exception as e:
        logger.exception('pipeline run failed')
        result['errors'].append(str(e))
        if driver is not None:
            scraper.dump_failure_state(driver, run_dir)
    finally:
        xlsx.close()
        if driver is not None:
            driver.quit()

    result['success'] = not result['errors']
    logger.info(f'=== run {run_id} finished: users={result["users_collected"]}, '
                f'pages={result["pages_processed"]}, success={result["success"]} ===')
    return result


if __name__ == '__main__':
    import sys
    logging.basicConfig(level=logging.INFO)
    r = main()
    sys.exit(0 if r['success'] else 1)
